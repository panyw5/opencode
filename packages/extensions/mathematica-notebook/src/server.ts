import {
  defineServerExtension,
  type ExtensionHost,
  type ExtensionService,
  type RpcHandler,
} from "@opencode-ai/extension-kit/server"
import { tool } from "@opencode-ai/plugin/tool"
import { readFile, open, realpath, stat, rename, rm } from "node:fs/promises"
import { resolve, extname, dirname } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { editNotebook, parseNotebook, removeNotebookCacheId, NotebookParseError, type Edit } from "./notebook"
import { NotebookKernels, type Output } from "./kernel"
import { NotebookCache, cachedViewerCells, notebookBytes, type CachedNotebook } from "./cache"
import type { ViewerDocument } from "./document"
import { NotebookPreviews } from "./preview-service"
export type { ViewerDocument } from "./document"

export const ID = "local.mathematica-notebook"
export const EVENT = `${ID}/change`
export type Document = {
  path: string
  revision: string
  cells: ReturnType<typeof parseNotebook>["cells"]
  outputs: Record<number, Output>
}
const LIMIT = 20 * 1024 * 1024
const revision = (source: string | Uint8Array) => createHash("sha256").update(source).digest("hex")
type Timings = {
  readMs: number
  hashMs: number
  parseMs: number
  cacheMs: number
  dtoMs: number
  cacheHits: number
  cacheMisses: number
  bytes: number
  cells: number
}
type Snapshot = { source: string; revision: string; entry: CachedNotebook }

export function createNotebookService(host: ExtensionHost, kernels = new NotebookKernels(host)): ExtensionService {
  const outputs = new Map<string, { revision: string; values: Record<number, Output> }>()
  const locks = new Set<string>()
  const cache = new NotebookCache(8, 16 * 1024 * 1024)
  const previews = new NotebookPreviews(host.log)
  let disposed = false
  const check = (signal: AbortSignal) => {
    signal.throwIfAborted()
    if (disposed) throw new Error("Notebook extension is stopped")
  }
  const pathOf = async (input: unknown, directory?: string) => {
    const path = (input as { path?: unknown })?.path
    if (typeof path !== "string" || !path.trim() || extname(path).toLowerCase() !== ".nb")
      throw new Error("A .nb file path is required")
    return realpath(resolve(directory ?? process.cwd(), path))
  }
  const measure = <T>(timings: Timings, key: "hashMs" | "parseMs" | "cacheMs" | "dtoMs", fn: () => T): T => {
    const start = performance.now()
    try {
      return fn()
    } finally {
      timings[key] += performance.now() - start
    }
  }
  const readSource = async (path: string, signal: AbortSignal, timings: Timings) => {
    check(signal)
    const start = performance.now()
    try {
      if ((await stat(path)).size > LIMIT) throw new Error("Notebook exceeds the 20 MB preview limit")
      check(signal)
      const bytes = await readFile(path, { signal })
      check(signal)
      if (bytes.byteLength > LIMIT) throw new Error("Notebook exceeds the 20 MB preview limit")
      timings.bytes = bytes.byteLength
      return bytes
    } finally {
      timings.readMs += performance.now() - start
    }
  }
  const hash = (source: string | Uint8Array, signal: AbortSignal, timings: Timings) => {
    check(signal)
    const version = measure(timings, "hashMs", () => revision(source))
    check(signal)
    return version
  }
  const parsed = (
    path: string,
    source: string,
    version: string,
    signal: AbortSignal,
    timings: Timings,
    pending: Map<string, CachedNotebook>,
  ): CachedNotebook => {
    check(signal)
    const hit = measure(timings, "cacheMs", () => pending.get(version) ?? cache.get(version))
    if (hit) {
      timings.cacheHits++
      timings.cells = hit.notebook.cells.length
      return hit
    }
    timings.cacheMisses++
    const notebook = measure(timings, "parseMs", () => {
      try {
        return parseNotebook(source)
      } catch (error) {
        host.log.error("notebook parsing failed", {
          path,
          bytes: timings.bytes,
          error: String(error),
          ...(error instanceof NotebookParseError
            ? { offset: error.offset, line: error.line, column: error.column }
            : {}),
        })
        throw error
      }
    })
    check(signal)
    const entry = { notebook, bytes: measure(timings, "cacheMs", () => notebookBytes(notebook, source.length)) }
    timings.cells = notebook.cells.length
    pending.set(version, entry)
    return entry
  }
  const load = async (
    path: string,
    signal: AbortSignal,
    timings: Timings,
    pending: Map<string, CachedNotebook>,
  ): Promise<Snapshot> => {
    const bytes = await readSource(path, signal, timings)
    const version = hash(bytes, signal, timings)
    check(signal)
    const source = bytes.toString("utf8")
    return { source, revision: version, entry: parsed(path, source, version, signal, timings, pending) }
  }
  const document = (
    path: string,
    snapshot: Pick<Snapshot, "revision" | "entry">,
    view: boolean,
    signal: AbortSignal,
    timings: Timings,
  ): Document | ViewerDocument => {
    check(signal)
    return measure(timings, "dtoMs", () => {
      const previous = outputs.get(path)
      return {
        path,
        revision: snapshot.revision,
        cells: view ? cachedViewerCells(snapshot.entry) : snapshot.entry.notebook.cells,
        outputs: previous?.revision === snapshot.revision ? previous.values : {},
      }
    })
  }
  const request = async <T>(
    action: string,
    input: unknown,
    ctx: Parameters<RpcHandler>[1],
    fn: (path: string, timings: Timings, pending: Map<string, CachedNotebook>) => Promise<T>,
  ): Promise<T> => {
    const start = performance.now()
    const timings: Timings = {
      readMs: 0,
      hashMs: 0,
      parseMs: 0,
      cacheMs: 0,
      dtoMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytes: 0,
      cells: 0,
    }
    const pending = new Map<string, CachedNotebook>()
    let path: string | undefined
    let status = "failed"
    try {
      check(ctx.signal)
      path = await pathOf(input, ctx.directory)
      check(ctx.signal)
      const result = await fn(path, timings, pending)
      check(ctx.signal)
      measure(timings, "cacheMs", () => {
        for (const [version, entry] of pending) cache.set(version, entry)
      })
      status = "ok"
      return result
    } finally {
      host.log.info(`notebook ${action}`, {
        path: path ?? "",
        status: ctx.signal.aborted ? "cancelled" : status,
        ...timings,
        totalMs: performance.now() - start,
        cacheEntries: cache.size,
        cacheBytes: cache.bytes,
      })
    }
  }
  const rpc: Record<string, RpcHandler> = {
    "notebook.open": async (input, ctx) => {
      check(ctx.signal)
      const path = await pathOf(input, ctx.directory)
      const result = await previews.call<ViewerDocument>("open", path, {}, ctx.signal)
      const previous = outputs.get(path)
      return { ...result, outputs: previous?.revision === result.revision ? previous.values : {} }
    },
    "notebook.cells": async (input, ctx) => {
      check(ctx.signal)
      const path = await pathOf(input, ctx.directory)
      return previews.call("cells", path, input, ctx.signal)
    },
    "notebook.read": async (input, ctx) =>
      request("read", input, ctx, async (path, timings, pending) => {
        const snapshot = await load(path, ctx.signal, timings, pending)
        return document(path, snapshot, (input as { view?: unknown })?.view === true, ctx.signal, timings)
      }),
    "notebook.save": async (input, ctx) =>
      request("save", input, ctx, async (path, timings, pending) => {
        if (locks.has(path)) throw new Error("Notebook is being saved; retry after reading it again")
        locks.add(path)
        try {
          const data = input as {
            revision?: unknown
            edits?: unknown
            append?: { style?: unknown; text?: unknown }
            view?: unknown
            preview?: unknown
          }
          if (
            !Array.isArray(data.edits) ||
            data.edits.some((edit) => !edit || !Number.isInteger(edit.index) || typeof edit.text !== "string")
          )
            throw new Error("edits must contain cell index/text pairs")
          if (
            data.append &&
            (!["Input", "Text"].includes(String(data.append.style)) || typeof data.append.text !== "string")
          )
            throw new Error("append requires Input/Text style and text")
          const current = await load(path, ctx.signal, timings, pending)
          if (data.revision !== current.revision)
            throw new Error("Notebook changed on disk. Reload before saving; your draft has not been written.")
          check(ctx.signal)
          // Cache offsets in Mathematica's trailing outline are invalid after edits.
          // Remove CacheID before hashing and parsing the exact bytes to be written.
          const next = removeNotebookCacheId(
            editNotebook(
              current.source,
              data.edits as Edit[],
              data.append as { style: "Input" | "Text"; text: string } | undefined,
              current.entry.notebook,
            ),
          )
          check(ctx.signal)
          const bytes = Buffer.from(next)
          if (bytes.byteLength > LIMIT) throw new Error("Notebook exceeds the 20 MB preview limit")
          const version = hash(bytes, ctx.signal, timings)
          const entry = parsed(path, bytes.toString("utf8"), version, ctx.signal, timings, pending)
          const temp = `${path}.${randomUUID()}.tmp`
          const mode = (await stat(path)).mode
          check(ctx.signal)
          const file = await open(temp, "wx", mode)
          try {
            check(ctx.signal)
            await file.writeFile(bytes, { signal: ctx.signal })
            check(ctx.signal)
            await file.sync()
            await file.close()
            if (hash(await readSource(path, ctx.signal, timings), ctx.signal, timings) !== current.revision)
              throw new Error("Notebook changed on disk while saving. Reload before saving.")
            check(ctx.signal)
            await rename(temp, path)
          } finally {
            await file.close().catch(() => {})
            await rm(temp, { force: true })
          }
          outputs.delete(path)
          host.emit(EVENT, { path, type: "saved", revision: version })
          if (data.preview === true) {
            const result = await previews.call<ViewerDocument>("open", path, {}, ctx.signal)
            return { ...result, outputs: {} }
          }
          return document(path, { revision: version, entry }, data.view === true, ctx.signal, timings)
        } finally {
          locks.delete(path)
        }
      }),
    "notebook.run": async (input, ctx) =>
      request("run", input, ctx, async (path, timings, pending) => {
        const data = input as { index?: unknown; code?: unknown; revision?: unknown }
        const snapshot = await load(path, ctx.signal, timings, pending)
        if (data.revision !== snapshot.revision) throw new Error("Notebook changed on disk. Reload before running.")
        if (!Number.isInteger(data.index)) throw new Error("A cell index is required")
        const index = data.index as number
        const cell = snapshot.entry.notebook.cells[index]
        if (!cell?.runnable)
          throw new Error("This cell is not a supported Input/Code cell. Use Source for complex boxes.")
        if (data.code !== undefined && typeof data.code !== "string") throw new Error("code must be a string")
        check(ctx.signal)
        const output = await kernels.evaluate(path, typeof data.code === "string" ? data.code : cell.text, ctx.signal)
        check(ctx.signal)
        const previous = outputs.get(path)
        const current = previous?.revision === snapshot.revision ? previous.values : {}
        current[index] = output
        outputs.set(path, { revision: snapshot.revision, values: current })
        host.emit(EVENT, { path, type: "output", index, output, revision: snapshot.revision })
        return output
      }),
    "kernel.stop": async (input, ctx) => {
      const path = await pathOf(input, ctx.directory)
      await kernels.stop(path)
      host.emit(EVENT, { path, type: "stopped" })
      return { stopped: true }
    },
  }
  return {
    rpc,
    dispose: () => {
      disposed = true
      cache.clear()
      outputs.clear()
      locks.clear()
      return Promise.all([previews.dispose(), kernels.dispose()]).then(() => {})
    },
  }
}

export default defineServerExtension({
  id: ID,
  activate: async (host) => {
    host.log.info("activating Mathematica Notebook")
    return createNotebookService(host)
  },
  server: async (input) => ({
    tool: {
      mathematica_notebook: tool({
        description:
          "Read, edit, append or run Mathematica .nb cells. Read first for zero-based indices and revision. Preview never evaluates code. Running shares a persistent kernel with the user. Outputs are transient, not saved into the .nb. Unsupported boxes are read-only and preserved. A stop resets kernel variables.",
        args: {
          path: tool.schema.string().describe("Notebook path, relative to project or absolute"),
          action: tool.schema.enum(["read", "edit", "append", "run", "stop"]),
          revision: tool.schema.string().optional().describe("Revision from read; required for edit, append, run"),
          index: tool.schema.number().int().nonnegative().optional(),
          text: tool.schema.string().optional().describe("New cell text for edit/append"),
          style: tool.schema.enum(["Input", "Text"]).optional(),
        },
        execute: async (args, ctx) => {
          if (input.extension.settings.get().exposeTool === "never")
            throw new Error("Agent notebook access is disabled")
          const method = {
            read: "notebook.read",
            edit: "notebook.save",
            append: "notebook.save",
            run: "notebook.run",
            stop: "kernel.stop",
          }[args.action]
          const handler = input.extension.service?.rpc?.[method]
          if (!handler) throw new Error("Notebook service is unavailable")
          const path = resolve(ctx.directory ?? input.directory, args.path)
          await ctx.ask({
            permission:
              args.action === "read" ? "read" : args.action === "edit" || args.action === "append" ? "edit" : "bash",
            patterns: [path],
            always: [dirname(path) + "/*"],
            metadata: { action: args.action, path },
          })
          const result = await handler(
            {
              ...args,
              path,
              edits: args.action === "edit" ? [{ index: args.index, text: args.text }] : [],
              append: args.action === "append" ? { style: args.style ?? "Input", text: args.text ?? "" } : undefined,
            },
            { directory: ctx.directory ?? input.directory, signal: ctx.abort },
          )
          if (args.action === "read" || args.action === "edit" || args.action === "append") {
            const document = result as Document
            return JSON.stringify({
              ...document,
              outputs: Object.fromEntries(
                Object.entries(document.outputs).map(([index, value]) => [
                  index,
                  { ...value, image: value.image ? "PNG available; run cell to receive image attachment" : undefined },
                ]),
              ),
              cells: document.cells.map(({ raw, start, end, ...cell }) => cell),
            })
          }
          const output = result as Output
          if (output.image)
            return {
              output: JSON.stringify({ ...output, image: undefined }),
              attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${output.image}` }],
            }
          return JSON.stringify(result)
        },
      }),
    },
  }),
})
