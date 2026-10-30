import type { GptProJob } from "@opencode-ai/util/gpt-pro"
import type { GptProBodyStore } from "./gpt-pro-body-journal"

type Database = {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...values: (string | number)[]): unknown
    get(...values: (string | number)[]): unknown
    all(...values: (string | number)[]): unknown[]
  }
  close(): void
}
type Body = Pick<GptProJob, "text" | "html" | "revision">
type Cached = { metadata: string; outboxKey: string; notificationText?: string; body: Body }
const terminal = (job: GptProJob) =>
  ["completed", "failed", "cancelled", "interrupted", "send_uncertain", "paused"].includes(job.phase)
const outboxKey = (job: GptProJob) =>
  (job.notifications ?? [])
    .map((event) => `${event.id}:${event.errorCode ?? ""}:${event.recovery?.humanAction ?? ""}`)
    .join("\n")

/** Profile-local execution journal. Sending authority is committed synchronously, answers checkpoint independently. */
export function createGptProExecutionStore(
  db: Database,
  log: (message: string) => void,
  checkpointMs = 500,
  bodies?: GptProBodyStore,
) {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;")
  db.exec(`CREATE TABLE IF NOT EXISTS gpt_pro_execution(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, outbox TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gpt_pro_body(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS gpt_pro_migration(version INTEGER PRIMARY KEY);`)
  const put = db.prepare(
    "INSERT INTO gpt_pro_execution VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,outbox=excluded.outbox",
  )
  const putBody = db.prepare("INSERT INTO gpt_pro_body VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
  const remove = db.prepare("DELETE FROM gpt_pro_execution WHERE id=?")
  const removeBody = db.prepare("DELETE FROM gpt_pro_body WHERE id=?")
  const cache = new Map<string, Cached>()
  const pending = new Map<string, Body>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const metrics = { metadataWrites: 0, bodyWrites: 0, outboxWrites: 0, serializedBytes: 0 }
  const writeBody = (id: string, body: Body) => {
    const raw = JSON.stringify(body)
    putBody.run(id, raw)
    metrics.bodyWrites++
    metrics.serializedBytes += Buffer.byteLength(raw)
  }
  const flush = () => {
    if (bodies) return bodies.flush()
    clearTimeout(timer)
    timer = undefined
    if (!pending.size) return
    const start = performance.now()
    const before = { ...metrics }
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const [id, body] of pending) writeBody(id, body)
      db.exec("COMMIT")
      log(
        `execution body checkpoint jobs=${pending.size} durationMs=${(performance.now() - start).toFixed(2)}; content omitted`,
      )
      pending.clear()
    } catch (error) {
      db.exec("ROLLBACK")
      Object.assign(metrics, before)
      log("execution body checkpoint failed; previous checkpoints retained")
      throw error
    }
  }
  const schedule = () => {
    if (bodies || timer || !pending.size || closed) return
    timer = setTimeout(() => {
      timer = undefined
      try {
        flush()
      } catch {
        schedule()
      }
    }, checkpointMs)
    timer.unref?.()
  }
  const save = (jobs: GptProJob[], force = false) => {
    if (closed) throw new Error("Execution store closed")
    const started = performance.now()
    const next = new Map<string, Cached>()
    const checkpoint = new Map(pending)
    const changedBodies = new Map<string, Body>()
    const removed: string[] = []
    const before = { ...metrics }
    let changed = 0
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const job of jobs) {
        const { text, html, revision, notifications, notificationText, ...metadata } = job
        const raw = JSON.stringify(metadata)
        const key = outboxKey(job)
        const previous = cache.get(job.id)
        const outboxChanged = !previous || previous.outboxKey !== key || previous.notificationText !== notificationText
        if (!previous || previous.metadata !== raw || outboxChanged) {
          // Do not serialize old answer snapshots in unchanged outboxes.
          if (outboxChanged) {
            const outbox = JSON.stringify({ notifications, notificationText })
            put.run(job.id, raw, outbox)
            metrics.serializedBytes += Buffer.byteLength(raw) + Buffer.byteLength(outbox)
            metrics.outboxWrites++
          } else {
            db.prepare("UPDATE gpt_pro_execution SET metadata=? WHERE id=?").run(raw, job.id)
            metrics.serializedBytes += Buffer.byteLength(raw)
          }
          metrics.metadataWrites++
          changed++
        }
        const body = { text, html, revision }
        if (
          !previous ||
          previous.body.text !== text ||
          previous.body.html !== html ||
          previous.body.revision !== revision
        )
          if (bodies && !force) changedBodies.set(job.id, body)
          else checkpoint.set(job.id, body)
        if ((force || (!bodies && terminal(job))) && checkpoint.has(job.id)) {
          writeBody(job.id, checkpoint.get(job.id)!)
          checkpoint.delete(job.id)
        }
        next.set(job.id, { metadata: raw, outboxKey: key, notificationText, body })
      }
      for (const id of cache.keys()) {
        if (next.has(id)) continue
        remove.run(id)
        removeBody.run(id)
        checkpoint.delete(id)
        removed.push(id)
      }
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      Object.assign(metrics, before)
      log("execution commit rejected; sending authority and previous state retained")
      throw error
    }
    cache.clear()
    for (const [id, value] of next) cache.set(id, value)
    pending.clear()
    for (const [id, value] of checkpoint) pending.set(id, value)
    for (const [id, body] of changedBodies) bodies?.stage(id, body)
    if (bodies && [...changedBodies.keys()].some((id) => jobs.some((job) => job.id === id && terminal(job))))
      void bodies
        .flush()
        .catch(() => log("terminal answer checkpoint failed; original page retained, final completion not authorized"))
    for (const id of removed) bodies?.remove(id)
    schedule()
    log(
      `execution commit jobs=${jobs.length} changed=${changed} pendingBodies=${pending.size} durationMs=${(performance.now() - started).toFixed(2)}; content omitted`,
    )
  }
  return {
    load(legacy: () => GptProJob[]) {
      if (!db.prepare("SELECT version FROM gpt_pro_migration WHERE version=1").get()) {
        const jobs = legacy()
        save(jobs, true)
        db.prepare("INSERT INTO gpt_pro_migration VALUES(1)").run()
        log(`execution legacy migration committed jobs=${jobs.length}; original archive left read-only`)
      }
      const jobs = db
        .prepare("SELECT e.metadata,e.outbox,b.data FROM gpt_pro_execution e LEFT JOIN gpt_pro_body b ON b.id=e.id")
        .all()
        .map((row) => {
          const value = row as { metadata: string; outbox: string; data?: string }
          const metadata = JSON.parse(value.metadata)
          return {
            ...metadata,
            ...JSON.parse(value.outbox),
            ...(bodies?.read(metadata.id) ?? (value.data ? JSON.parse(value.data) : { revision: 0 })),
          } as GptProJob
        })
      // Prime equality evidence without rewriting any rows.
      for (const job of jobs) {
        const { text, html, revision, notifications, notificationText, ...metadata } = job
        cache.set(job.id, {
          metadata: JSON.stringify(metadata),
          outboxKey: outboxKey(job),
          notificationText,
          body: { text, html, revision },
        })
      }
      return jobs
    },
    save,
    flush,
    metrics: () => ({ ...metrics, pendingBodies: pending.size }),
    close() {
      const flushed = flush()
      closed = true
      if (flushed) return flushed.finally(() => db.close())
      db.close()
    },
  }
}
