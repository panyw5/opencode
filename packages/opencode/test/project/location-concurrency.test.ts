import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { watch } from "node:fs"
import fs from "fs/promises"
import path from "path"

import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/project-location-worker.ts")

type Result = {
  locationID: string
  claimed: { sessions: number; scheduledTasks: number; workspaces: number }
}

function run(input: Record<string, unknown>, db: string, data: string) {
  return Process.run([process.execPath, worker, JSON.stringify({ ...input, db })], {
    cwd: root,
    env: { OPENCODE_DB: db, XDG_DATA_HOME: data },
    nothrow: true,
  })
}

async function waitFor(files: string[]) {
  await new Promise<void>((resolve, reject) => {
    let checking = false
    let pending = false
    let finished = false
    const watcher = watch(path.dirname(files[0]), check)
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for worker readiness: ${files.join(", ")}`)),
      10_000,
    )
    function finish(error?: Error) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      watcher.close()
      error ? reject(error) : resolve()
    }
    async function check() {
      if (checking) return void (pending = true)
      checking = true
      do {
        pending = false
        try {
          const checks = await Promise.allSettled(files.map((file) => fs.access(file)))
          if (checks.every((result) => result.status === "fulfilled")) return finish()
        } catch (error) {
          return finish(error instanceof Error ? error : new Error(String(error)))
        }
      } while (pending)
      checking = false
    }
    void check()
  })
}

describe("ProjectLocation multi-process convergence", () => {
  test("upsert and claimLegacyDirectory converge idempotently", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "concurrency.db")
    const dataPath = path.join(tmp.path, "data")
    const directory = path.join(tmp.path, "project")
    const projectID = `project-concurrency-${crypto.randomUUID()}`
    await fs.mkdir(directory)

    const migrated = await run({ action: "migrate" }, dbPath, dataPath)
    expect(migrated.code, migrated.stderr.toString()).toBe(0)
    expect(dbPath.startsWith(tmp.path)).toBe(true)

    const sqlite = new SQLite(dbPath)
    const now = Date.now()
    sqlite.run(
      "INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES (?, ?, '[]', ?, ?), (?, ?, '[]', ?, ?)",
      ["global", "/", now, now, projectID, directory, now, now],
    )
    sqlite.run(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'legacy', ?, 'legacy', 'test', ?, ?)",
      [`session-${crypto.randomUUID()}`, directory, now, now],
    )
    sqlite.run(
      "INSERT INTO scheduled_task (id, project_id, directory, name, prompt, schedule_kind, schedule_value, execution_mode, agent, model, next_run_at, time_created, time_updated) VALUES (?, 'global', ?, 'legacy', 'test', 'at', ?, 'new_session', 'build', ?, ?, ?, ?)",
      [
        `task-${crypto.randomUUID()}`,
        directory,
        String(now),
        JSON.stringify({ providerID: "test", modelID: "test" }),
        now,
        now,
        now,
      ],
    )
    sqlite.run(
      "INSERT INTO workspace (id, type, directory, project_id, time_used) VALUES (?, 'local', ?, 'global', ?)",
      [`workspace-${crypto.randomUUID()}`, directory, now],
    )
    sqlite.close()

    const go = path.join(tmp.path, "go")
    const ready = [path.join(tmp.path, "ready-1"), path.join(tmp.path, "ready-2")]
    const output = [path.join(tmp.path, "output-1"), path.join(tmp.path, "output-2")]
    const workers = ready.map((readyFile, index) =>
      run({ action: "claim", directory, projectID, ready: readyFile, go, output: output[index] }, dbPath, dataPath),
    )
    try {
      await waitFor(ready)
    } catch (error) {
      await fs.writeFile(go, "release-after-ready-failure")
      const failed = await Promise.all(workers)
      const diagnostics = failed.map((result) => result.stderr.toString()).join("\n--- worker ---\n")
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`)
    }
    await fs.writeFile(go, "go")
    const results = await Promise.all(workers)
    expect(
      results.map((result) => result.code),
      results.map((result) => result.stderr.toString()).join("\n"),
    ).toEqual([0, 0])

    const claims = await Promise.all(
      output.map((file) => fs.readFile(file, "utf8").then((text) => JSON.parse(text) as Result)),
    )
    expect(new Set(claims.map((result) => result.locationID)).size).toBe(1)
    expect(claims.reduce((sum, result) => sum + result.claimed.sessions, 0)).toBe(1)
    expect(claims.reduce((sum, result) => sum + result.claimed.scheduledTasks, 0)).toBe(1)
    expect(claims.reduce((sum, result) => sum + result.claimed.workspaces, 0)).toBe(1)

    const repeatedOutput = path.join(tmp.path, "output-repeat")
    const repeatedProcess = await run(
      { action: "claim", directory, projectID, ready: path.join(tmp.path, "ready-repeat"), go, output: repeatedOutput },
      dbPath,
      dataPath,
    )
    expect(repeatedProcess.code, repeatedProcess.stderr.toString()).toBe(0)
    const repeated = JSON.parse(await fs.readFile(repeatedOutput, "utf8")) as Result
    expect(repeated.locationID).toBe(claims[0].locationID)
    expect(repeated.claimed).toEqual({ sessions: 0, scheduledTasks: 0, workspaces: 0 })

    const verify = new SQLite(dbPath)
    expect(
      verify.query("SELECT count(*) AS count FROM project_location WHERE canonical_directory = ?").get(directory),
    ).toEqual({ count: 1 })
    for (const table of ["session", "scheduled_task", "workspace"]) {
      expect(verify.query(`SELECT project_id, location_id FROM ${table}`).get()).toEqual({
        project_id: projectID,
        location_id: claims[0].locationID,
      })
    }
    verify.close()
  }, 30_000)
})
