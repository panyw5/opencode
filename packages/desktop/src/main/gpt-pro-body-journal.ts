import { createHash, randomUUID } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import { GptProOperationError } from "@opencode-ai/util/gpt-pro-error"

export type GptProBody = Pick<GptProJob, "text" | "html" | "revision">
export type GptProBodyStore = {
  read(id: string): GptProBody | undefined
  stage(id: string, body: GptProBody): void
  remove(id: string): void
  flush(): Promise<void>
}

/** Independent per-job files keep large body I/O off both the event loop and the critical SQLite lock. */
export function createGptProBodyJournal(
  root: string,
  log: (message: string) => void,
  options: {
    checkpointMs?: number
    commit?: (id: string, body: GptProBody) => Promise<void>
  } = {},
) {
  const pending = new Map<string, GptProBody>()
  let writing: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let closed = false
  const metrics = { writes: 0, serializedBytes: 0, maxEncodeMs: 0, maxCommitMs: 0 }
  const file = (id: string) => join(root, `${createHash("sha256").update(id).digest("hex")}.json`)
  const commit = async (id: string, body: GptProBody) => {
    const start = performance.now()
    if (options.commit) {
      await options.commit(id, body)
      metrics.writes++
      return
    }
    const encodedAt = performance.now()
    const raw = JSON.stringify({ version: 1, id, ...body })
    metrics.maxEncodeMs = Math.max(metrics.maxEncodeMs, performance.now() - encodedAt)
    await mkdir(root, { recursive: true, mode: 0o700 })
    const temp = `${file(id)}.${randomUUID()}.tmp`
    try {
      const handle = await open(temp, "wx", 0o600)
      try {
        await handle.writeFile(raw)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temp, file(id))
      if (process.platform !== "win32") {
        const directory = await open(root, "r")
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
      metrics.writes++
      metrics.serializedBytes += Buffer.byteLength(raw)
      metrics.maxCommitMs = Math.max(metrics.maxCommitMs, performance.now() - start)
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }
  const flush = async (): Promise<void> => {
    clearTimeout(timer)
    timer = undefined
    if (writing) {
      await writing
      return flush()
    }
    const task = (async () => {
      try {
        const batch = [...pending.keys()]
        for (const id of batch) {
          const body = pending.get(id)
          if (!body) continue
          await commit(id, body)
          if (pending.get(id) === body) pending.delete(id)
        }
        log(`body journal checkpoint jobs=${batch.length} remaining=${pending.size}; content omitted`)
        failures = 0
      } catch {
        failures++
        log(`body journal checkpoint failed pending=${pending.size}; previous atomic files retained`)
        throw new GptProOperationError(
          "result_storage",
          "The answer could not be durably checkpointed. The original page was preserved; no question was resent.",
        )
      }
    })()
    writing = task
    try {
      await task
    } finally {
      if (writing === task) writing = undefined
      schedule()
    }
  }
  const schedule = () => {
    if (timer || writing || closed || !pending.size) return
    const delay = Math.min(60_000, (options.checkpointMs ?? 500) * 2 ** Math.min(failures, 7))
    timer = setTimeout(() => {
      timer = undefined
      void flush()
        .catch(() => {})
        .finally(schedule)
    }, delay)
    timer.unref?.()
  }
  return {
    read(id: string): GptProBody | undefined {
      try {
        if (statSync(file(id)).size > 16 * 1024 * 1024) throw Error("oversized")
        const value = JSON.parse(readFileSync(file(id), "utf8"))
        if (
          value.version !== 1 ||
          value.id !== id ||
          !Number.isSafeInteger(value.revision) ||
          value.revision < 0 ||
          (value.text !== undefined && typeof value.text !== "string") ||
          (value.html !== undefined && typeof value.html !== "string")
        )
          throw Error("invalid")
        return { text: value.text, html: value.html, revision: value.revision }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw new GptProOperationError(
          "result_storage",
          "A stored answer checkpoint is unreadable. It was preserved; no execution was replayed.",
        )
      }
    },
    stage(id: string, body: GptProBody) {
      if (closed) throw new Error("Body journal closed")
      pending.set(id, { ...body })
      schedule()
    },
    remove(id: string) {
      pending.delete(id)
      void (writing ?? Promise.resolve())
        .catch(() => {})
        .then(() => rm(file(id), { force: true }))
        .catch(() => log("retired body file cleanup deferred"))
    },
    flush,
    metrics: () => ({ ...metrics, pending: pending.size }),
    async close() {
      closed = true
      clearTimeout(timer)
      await flush()
    },
  }
}
