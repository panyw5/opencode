import fs from "fs/promises"
import { watch } from "node:fs"
import path from "path"

import { Database } from "@/storage/db"
import { Project } from "@/project/project"
import { ProjectLocation } from "@/project/location"
import { ProjectID } from "@/project/schema"

type Input = {
  action: "migrate" | "claim"
  db: string
} & Partial<Record<"directory" | "projectID" | "ready" | "go" | "output", string>>

function log(step: string, detail?: string) {
  process.stderr.write(`project-location-worker pid=${process.pid} step=${step}${detail ? ` ${detail}` : ""}\n`)
}

function waitFor(file: string) {
  return new Promise<void>((resolve, reject) => {
    let checking = false
    let pending = false
    let finished = false
    const watcher = watch(path.dirname(file), check)
    function finish(error?: unknown) {
      if (finished) return
      finished = true
      watcher.close()
      error ? reject(error) : resolve()
    }
    async function check() {
      if (checking) return void (pending = true)
      checking = true
      do {
        pending = false
        try {
          await fs.access(file)
          return finish()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return finish(error)
        }
      } while (pending)
      checking = false
    }
    void check()
  })
}

async function main() {
  const input = JSON.parse(process.argv[2] ?? "null") as Input
  log("start", `action=${input?.action}`)
  if (!input || input.db !== process.env.OPENCODE_DB || !input.db.startsWith("/")) {
    throw new Error("Worker requires an explicit temporary OPENCODE_DB")
  }
  Database.Client({ disableChannelDb: true, skipMigrations: input.action === "claim" })
  log("db-ready", `db=${input.db}`)
  if (input.action === "migrate") {
    Database.close()
    Database.Client({ disableChannelDb: true, skipMigrations: false })
    log("db-journal-ready")
    return
  }
  if (!input.directory || !input.projectID || !input.ready || !input.go || !input.output) {
    throw new Error("Invalid claim worker input")
  }

  const gate = waitFor(input.go)
  await fs.writeFile(input.ready, String(process.pid))
  log("gate-ready")
  await gate

  const projectID = ProjectID.make(input.projectID)
  const location = ProjectLocation.upsert({
    projectID,
    directory: input.directory,
    canonicalDirectory: input.directory,
    kind: "directory",
    vcsState: "none",
    worktreeRoot: input.directory,
  })
  log("upsert", `location=${location.id}`)
  const claimed = Project.claimLegacyDirectory({ directory: input.directory, projectID, locationID: location.id })
  log("claim", JSON.stringify(claimed))
  await fs.writeFile(input.output, JSON.stringify({ locationID: location.id, claimed }))
}

await main()
  .finally(() => Database.close())
  .catch((error) => {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error))
    process.exitCode = 1
  })
