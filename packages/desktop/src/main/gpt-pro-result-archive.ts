import { readFileSync, statSync } from "node:fs"
import type { GptProJob } from "@opencode-ai/util/gpt-pro"

type Database = {
  exec(sql: string): unknown
  prepare(sql: string): { run(...args: (string | number)[]): unknown; get(...args: (string | number)[]): unknown }
  close(): void
}

function final(job: GptProJob) {
  return ["completed", "failed", "cancelled"].includes(job.phase)
}

// Execution state remains profile-local. Only immutable, owner-scoped answer
// snapshots cross the installed/development boundary; never credentials or pages.
export function createGptProResultArchive(db: Database, legacyFiles: string[], log: (message: string) => void) {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;")
  db.exec(`CREATE TABLE IF NOT EXISTS gpt_pro_result (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL
  )`)
  const put = db.prepare(`INSERT INTO gpt_pro_result(id,owner,updated_at,data) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data
    WHERE excluded.owner=gpt_pro_result.owner AND excluded.updated_at>gpt_pro_result.updated_at`)
  const get = db.prepare("SELECT data FROM gpt_pro_result WHERE id=?")
  const seen = new Map<string, number>()
  const files = new Map<string, string>()
  const save = (jobs: GptProJob[]) => {
    for (const job of jobs) {
      if (!final(job) || seen.get(job.id) === job.updatedAt) continue
      const snapshot: GptProJob = {
        id: job.id,
        owner: job.owner,
        requestID: job.requestID,
        prompt: job.prompt,
        parentID: job.parentID,
        successorID: job.successorID,
        phase: job.phase,
        url: job.url,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        submitted: job.submitted,
        revision: job.revision,
        text: job.text,
        html: job.html,
        error: job.error,
        errorCode: job.errorCode,
        model: job.model,
      }
      put.run(job.id, job.owner, job.updatedAt, JSON.stringify(snapshot))
      seen.set(job.id, job.updatedAt)
      log(`result archived id=${job.id} phase=${job.phase} text=${job.text?.length ?? 0} html=${job.html?.length ?? 0}`)
    }
  }
  const importLegacy = () => {
    for (const file of legacyFiles) {
      try {
        const stat = statSync(file)
        const stamp = `${stat.mtimeMs}:${stat.size}`
        if (files.get(file) === stamp) continue
        const value = JSON.parse(readFileSync(file, "utf8"))
        const jobs = Array.isArray(value.jobs)
          ? value.jobs.filter(
              (job: GptProJob) =>
                job &&
                typeof job.id === "string" &&
                typeof job.owner === "string" &&
                typeof job.prompt === "string" &&
                Number.isFinite(job.updatedAt) &&
                final(job),
            )
          : []
        save(jobs)
        files.set(file, stamp)
        log(`legacy result archive imported file=${file} terminal=${jobs.length}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          log(`legacy result archive import failed file=${file} error=${String(error)}`)
      }
    }
  }
  return {
    save,
    read(id: string, owners?: string[]) {
      importLegacy()
      const visited = new Set<string>()
      let current = id
      let owner: string | undefined
      while (!visited.has(current)) {
        visited.add(current)
        const row = get.get(current) as { data: string } | undefined
        if (!row) return
        const job = JSON.parse(row.data) as GptProJob
        if (!final(job) || (owners && !owners.includes(job.owner)) || (owner && job.owner !== owner)) return
        owner = job.owner
        if (!job.successorID) {
          log(`result archive read requested=${id} resolved=${job.id} phase=${job.phase}`)
          return job
        }
        current = job.successorID
      }
    },
    close: () => db.close(),
  }
}
