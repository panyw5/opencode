import { parentPort } from "node:worker_threads"
import { readFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { parseNotebook, type Notebook } from "./notebook"
import { notebookBytes } from "./cache"
import { previewBoxes } from "./box-preview"
import { PREVIEW_LIMITS as L, type CellsRequest, type CellsResponse, type Preview } from "./preview-protocol"

const port = parentPort!
const snapshots = new Map<string, { source: string; notebook: Notebook; bytes: number }>()
const rendered = new Map<string, { preview: Preview; bytes: number; wireBytes: number }>()
const MAX_BYTES = 48 * 1024 * 1024
let retained = 0
let renderedBytes = 0
function trim() {
  while (rendered.size && (renderedBytes > 4 * 1024 * 1024 || retained + renderedBytes > MAX_BYTES)) {
    const [key, entry] = rendered.entries().next().value!
    rendered.delete(key)
    renderedBytes -= entry.bytes
  }
  while (snapshots.size > 1 && (snapshots.size > 4 || retained + renderedBytes > MAX_BYTES)) {
    const [key, entry] = snapshots.entries().next().value!
    snapshots.delete(key)
    retained -= entry.bytes
  }
}
async function handle(method: string, path: string, input: CellsRequest, cancelled: () => boolean) {
  const check = () => {
    if (cancelled()) throw Error("Preview cancelled")
  }
  check()
  if (method === "open") {
    if ((await stat(path)).size > 20 * 1024 * 1024) throw Error("Notebook exceeds the 20 MB preview limit")
    const bytes = await readFile(path)
    check()
    if (bytes.length > 20 * 1024 * 1024) throw Error("Notebook exceeds the 20 MB preview limit")
    const revision = createHash("sha256").update(bytes).digest("hex")
    const key = `${path}\0${revision}`
    let entry = snapshots.get(key)
    const hit = !!entry
    if (!entry) {
      const source = bytes.toString("utf8")
      const notebook = parseNotebook(source, { preview: true })
      check()
      entry = { source, notebook, bytes: notebookBytes(notebook, source.length) }
      // A large active snapshot can exceed the cache estimate by itself, but
      // must remain usable; evict all other snapshots rather than reload per cell.
      snapshots.set(key, entry)
      retained += entry.bytes
    } else {
      snapshots.delete(key)
      snapshots.set(key, entry)
    }
    trim()
    const cells = entry.notebook.cells.map(
      ({ index, style, text, editable, runnable, parent, group, closed, start, end }) => ({
        index,
        style,
        editable,
        runnable,
        text: editable ? text.slice(0, L.inlineText) : "",
        characters: editable ? text.length : end - start,
        deferred: editable && text.length > L.inlineText,
        ...(parent === undefined ? {} : { parent }),
        ...(group === undefined ? {} : { group }),
        ...(closed === undefined ? {} : { closed }),
      }),
    )
    return {
      result: { path, revision, cells },
      metrics: { hit, cells: cells.length, bytes: bytes.length, cacheBytes: retained + renderedBytes },
    }
  }
  const key = `${path}\0${input.revision}`
  const entry = snapshots.get(key)
  if (!entry) throw Error("snapshot_expired: Reload the notebook to refresh its preview")
  snapshots.delete(key)
  snapshots.set(key, entry)
  const response: CellsResponse = { revision: input.revision, cells: [] }
  let bytes = 0
  let hits = 0
  for (const index of input.indexes) {
    check()
    const cell = entry.notebook.cells[index]
    if (!cell) throw Error("Invalid cell index")
    if (input.kind === "preview") {
      const cacheKey = `${key}\0${index}`
      let cached = rendered.get(cacheKey)
      if (cached) {
        hits++
        rendered.delete(cacheKey)
        rendered.set(cacheKey, cached)
      } else {
        const preview = previewBoxes(entry.source.slice(cell.start, cell.end), index, cancelled)
        check()
        const json = JSON.stringify(preview)
        cached = { preview, bytes: json.length * 2 + 128, wireBytes: Buffer.byteLength(json) + 64 }
        rendered.set(cacheKey, cached)
        renderedBytes += cached.bytes
        trim()
      }
      if (bytes + cached.wireBytes > L.batchBytes - 256 && response.cells.length) break
      response.cells.push({ index, preview: cached.preview })
      bytes += cached.wireBytes
    } else {
      if (input.kind === "text" && !cell.editable) throw Error("This cell has no editable plain text")
      const value = input.kind === "text" && cell.editable ? cell.text : entry.source.slice(cell.start, cell.end)
      const offset = input.offset ?? 0
      response.cells.push({ index, offset, total: value.length, text: value.slice(offset, offset + L.sourceChunk) })
      bytes += Buffer.byteLength(JSON.stringify(response.cells.at(-1)))
    }
  }
  return {
    result: response,
    metrics: { cells: response.cells.length, hits, bytes, cacheBytes: retained + renderedBytes },
  }
}

// Serialize requests so opens and cell requests cannot race snapshot mutation.
let queue = Promise.resolve()
port.on(
  "message",
  (message: { id: number; method: string; path: string; input: CellsRequest; cancel: SharedArrayBuffer }) => {
    queue = queue.then(async () => {
      const started = performance.now()
      try {
        const flag = new Int32Array(message.cancel)
        const { result, metrics } = await handle(
          message.method,
          message.path,
          message.input,
          () => Atomics.load(flag, 0) !== 0,
        )
        port.postMessage({
          id: message.id,
          result,
          metrics: {
            ...metrics,
            id: message.id,
            method: message.method,
            path: message.path,
            workerMs: performance.now() - started,
          },
        })
      } catch (error) {
        port.postMessage({ id: message.id, error: String(error) })
      }
    })
  },
)
