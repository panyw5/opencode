import { Worker } from "node:worker_threads"
import type { ExtensionHost } from "@opencode-ai/extension-kit/server"
import { PREVIEW_LIMITS as L, type CellsRequest } from "./preview-protocol"

export class NotebookPreviews {
  private worker?: Worker
  private sequence = 0
  private disposed = false
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()

  constructor(private log: ExtensionHost["log"]) {}

  private start() {
    if (this.disposed) throw Error("Notebook preview is stopped")
    if (this.worker) return this.worker
    const worker = new Worker(
      new URL(import.meta.url.endsWith(".ts") ? "./preview-worker.ts" : "./preview-worker.js", import.meta.url),
    )
    this.worker = worker
    worker.unref()
    this.log.info("notebook preview worker starting")
    worker.on("message", (message) => {
      const request = this.pending.get(message.id)
      if (!request) return
      if (message.error) request.reject(Error(message.error))
      else {
        this.log.info("notebook preview worker completed", message.metrics)
        request.resolve(message.result)
      }
    })
    worker.on("error", (error) => this.reset(error, worker))
    worker.on("exit", (code) => this.reset(Error(`Preview worker exited (${code})`), worker))
    return worker
  }

  private reset(error: Error, worker: Worker) {
    if (this.worker !== worker) return
    this.worker = undefined
    this.log.warn("notebook preview worker reset", { error: error.message })
    for (const request of [...this.pending.values()]) request.reject(error)
    void worker.terminate()
  }

  async call<T>(method: "open" | "cells", path: string, input: unknown, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    if (method === "cells") {
      if (!input || typeof input !== "object") throw Error("Invalid notebook preview request")
      const data = input as CellsRequest
      if (
        typeof data.revision !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.revision) ||
        !Array.isArray(data.indexes) ||
        !data.indexes.length ||
        data.indexes.length > L.batch ||
        data.indexes.some((index) => !Number.isInteger(index) || index < 0) ||
        !["preview", "text", "source"].includes(data.kind) ||
        (data.offset !== undefined && (!Number.isSafeInteger(data.offset) || data.offset < 0))
      )
        throw Error("Invalid notebook preview request")
    }
    // Bound the process-wide queue even when multiple windows scroll at once.
    if (this.pending.size >= 16) throw Error("Preview queue is busy; retry shortly")
    const worker = this.start()
    const id = ++this.sequence
    const started = performance.now()
    this.log.debug("notebook preview request", { id, method, path, queued: this.pending.size })
    return new Promise<T>((resolve, reject) => {
      const cancel = new SharedArrayBuffer(4)
      const flag = new Int32Array(cancel)
      let cancelled = false
      const finish = (error?: Error, result?: unknown) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        this.log.debug("notebook preview finished", {
          id,
          method,
          status: error ? "failed" : "ok",
          ms: performance.now() - started,
        })
        if (!this.pending.size) worker.unref()
        if (!cancelled) {
          if (error) reject(error)
          else resolve(result as T)
        }
      }
      // Keep the worker slot/watchdog until it acknowledges cancellation; a
      // disconnected client must not create an unbounded hidden worker queue.
      const abort = () => {
        cancelled = true
        Atomics.store(flag, 0, 1)
        reject(new Error("Preview cancelled"))
        this.log.debug("notebook preview cancelled", { id, method })
      }
      const timer = setTimeout(() => this.reset(Error("Preview worker timed out"), worker), 15_000)
      this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) })
      worker.ref()
      signal.addEventListener("abort", abort, { once: true })
      worker.postMessage({ id, method, path, input, cancel })
    })
  }

  async dispose() {
    this.disposed = true
    const worker = this.worker
    if (worker) {
      this.reset(Error("Notebook preview stopped"), worker)
      await worker.terminate()
    }
  }
}
