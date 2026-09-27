import * as InstanceState from "@/effect/instance-state"
import { File } from "@/file"
import { Ripgrep } from "@/file/ripgrep"
import { containsPath } from "@/project/instance-context"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { lstat, readFile, realpath } from "fs/promises"
import path from "path"
import { InstanceHttpApi } from "../api"
import { PayloadTooLargeError } from "../errors"

const RAW_FILE_MAX_BYTES = 50 * 1024 * 1024
const unsafeInlineMime = new Set(["text/html", "application/xhtml+xml"])

function rawMime(file: string) {
  const mime = AppFileSystem.mimeType(file).toLowerCase()
  if (unsafeInlineMime.has(mime)) return "application/octet-stream"
  return mime
}

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* File.Service
    const ripgrep = yield* Ripgrep.Service

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .search({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).items
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      return yield* svc.search({
        query: ctx.query.query,
        limit: ctx.query.limit ?? 10,
        dirs: ctx.query.dirs !== "false",
        type: ctx.query.type,
      })
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      return yield* svc.list(ctx.query.path)
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      return yield* svc.read(ctx.query.path)
    })

    const raw = Effect.fn("FileHttpApi.raw")(function* (ctx: { query: { path: string } }) {
      const instance = yield* InstanceState.context
      if (path.isAbsolute(ctx.query.path) || /^[A-Za-z]:[\\/]/.test(ctx.query.path)) {
        return yield* new HttpApiError.Forbidden({})
      }

      const full = path.join(instance.nativeDirectory, ctx.query.path)
      if (!containsPath(full, instance)) return yield* new HttpApiError.Forbidden({})

      const stat = yield* Effect.promise(() => lstat(full).catch(() => undefined))
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) return yield* new HttpApiError.NotFound({})
      const real = yield* Effect.promise(() => realpath(full).catch(() => undefined))
      if (!real) return yield* new HttpApiError.NotFound({})
      if (!containsPath(real, instance)) return yield* new HttpApiError.Forbidden({})
      if (stat.size > RAW_FILE_MAX_BYTES) {
        return yield* new PayloadTooLargeError({
          message: `File exceeds the ${RAW_FILE_MAX_BYTES} byte raw read limit`,
          maxBytes: RAW_FILE_MAX_BYTES,
        })
      }

      const body = yield* Effect.promise(() => readFile(real).catch(() => undefined))
      if (!body) return yield* new HttpApiError.NotFound({})
      return HttpServerResponse.uint8Array(body, {
        contentType: rawMime(real),
        headers: {
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      })
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return yield* svc.status()
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("raw", raw)
      .handle("status", status)
  }),
)
