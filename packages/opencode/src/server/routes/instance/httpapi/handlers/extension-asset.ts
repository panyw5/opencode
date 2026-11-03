import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { lstat, readFile, realpath } from "fs/promises"
import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Extension, extensionID } from "@/extension"

function notFound() {
  return HttpServerResponse.jsonUnsafe(
    { error: "Not Found" },
    { status: 404, headers: { "cache-control": "no-store" } },
  )
}

function decodeSegment(input: string | undefined) {
  if (!input) return
  try {
    const value = decodeURIComponent(input)
    if (!value || value.includes("\0") || value.includes("/") || value.includes("\\")) return
    return value
  } catch {
    return
  }
}

function decodeRelativePath(input: string | undefined) {
  if (!input) return
  try {
    const value = input
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/")
    if (!value || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return
    return value
  } catch {
    return
  }
}

function safeMime(file: string) {
  const mime = AppFileSystem.mimeType(file).toLowerCase()
  if (mime === "text/html" || mime === "application/xhtml+xml") return
  return mime
}

export const extensionAssetRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const extension = yield* Extension.Service
    yield* router.add("GET", "/extension-asset/:token/:id/:version/*", () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const params = yield* HttpRouter.params
        if (params.token !== extension.token) return notFound()

        const id = decodeSegment(params.id)
        const version = decodeSegment(params.version)
        const relative = decodeRelativePath(params["*"])
        if (!id || !version || !relative) return notFound()

        let asset
        try {
          asset = yield* extension.asset(extensionID(id), version)
        } catch {
          return notFound()
        }
        if (!asset) return notFound()

        const target = path.join(asset.webRoot, relative)
        const stat = yield* Effect.promise(() => lstat(target).catch(() => undefined))
        if (!stat?.isFile() || stat.isSymbolicLink()) return notFound()
        const real = yield* Effect.promise(() => realpath(target).catch(() => undefined))
        if (!real || !AppFileSystem.contains(asset.webRoot, real)) return notFound()
        const mime = safeMime(real)
        if (!mime) return notFound()
        const body = yield* Effect.promise(() => readFile(real).catch(() => undefined))
        if (!body) return notFound()

        return HttpServerResponse.uint8Array(body, {
          contentType: mime,
          headers: {
            "cache-control": asset.source === "path" ? "no-cache" : "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            "content-security-policy": "sandbox",
          },
        })
      }),
    )
  }),
)
