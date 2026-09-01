import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { migrateLegacyMathProject } from "@/math/migrate"
import { layout, mathRoot } from "@/math/layout"
import { readSwarm, writeSwarm } from "@/math/swarm"
import { tmpdir } from "../fixture/fixture"
import { spawnDetached } from "@/math/spawn"

describe("math.migrate", () => {
  test("copies one legacy store and rewrites durable worker paths", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, ".math", "legacy-proof")
    const sourceLayout = layout(source)
    mkdirSync(sourceLayout.tasks, { recursive: true })
    mkdirSync(sourceLayout.logs, { recursive: true })
    mkdirSync(sourceLayout.globalMemory, { recursive: true })
    writeFileSync(path.join(sourceLayout.tasks, "ses_worker.md"), "# Legacy task\n")
    writeFileSync(path.join(sourceLayout.logs, "worker.log"), "legacy log\n")
    writeFileSync(path.join(sourceLayout.globalMemory, "plan.jsonl"), '{"content":"plan"}\n')
    writeSwarm(source, {
      projectDir: source,
      workers: {
        ses_worker: {
          sessionID: "ses_worker",
          pid: 123,
          state: "dead",
          startedAt: 1,
          taskFile: path.join(sourceLayout.tasks, "ses_worker.md"),
          logFile: path.join(sourceLayout.logs, "worker.log"),
        },
      },
    })

    const result = migrateLegacyMathProject({
      workspace: tmp.path,
      source: "legacy-proof",
      problem: "problem-number-theory",
      now: new Date("2026-08-28T00:00:00.000Z"),
    })
    const target = mathRoot(tmp.path, "problem-number-theory")
    const targetSwarm = readSwarm(target)

    expect(result.projectDir).toBe(target)
    expect(existsSync(source)).toBe(true)
    expect(readFileSync(path.join(target, "TASKS", "ses_worker.md"), "utf8")).toContain("Legacy task")
    expect(targetSwarm.projectDir).toBe(target)
    expect(targetSwarm.workers.ses_worker?.taskFile).toBe(path.join(target, "TASKS", "ses_worker.md"))
    expect(targetSwarm.workers.ses_worker?.logFile).toBe(path.join(target, "logs", "worker.log"))
    expect(JSON.parse(readFileSync(path.join(target, "MIGRATION.json"), "utf8"))).toMatchObject({
      version: 1,
      source,
      target,
      problemID: "problem-number-theory",
      migratedAt: "2026-08-28T00:00:00.000Z",
      sourcePreserved: true,
    })
  })

  test("fails instead of merging into an existing problem workspace", async () => {
    await using tmp = await tmpdir()
    mkdirSync(path.join(tmp.path, ".math", "legacy"), { recursive: true })
    mkdirSync(mathRoot(tmp.path, "occupied"), { recursive: true })

    expect(() => migrateLegacyMathProject({ workspace: tmp.path, source: "legacy", problem: "occupied" })).toThrow(
      "already exists",
    )
  })

  test("rejects path traversal and symbolic links", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, ".math", "legacy")
    const outside = path.join(tmp.path, "outside.txt")
    mkdirSync(source, { recursive: true })
    writeFileSync(outside, "outside\n")
    symlinkSync(outside, path.join(source, "outside-link"))

    expect(() => migrateLegacyMathProject({ workspace: tmp.path, source: "../outside", problem: "safe" })).toThrow(
      "invalid project name",
    )
    expect(() => migrateLegacyMathProject({ workspace: tmp.path, source: "legacy", problem: "../escape" })).toThrow(
      "invalid project name",
    )
    expect(() => migrateLegacyMathProject({ workspace: tmp.path, source: "legacy", problem: "safe" })).toThrow(
      "symbolic link",
    )
    expect(existsSync(mathRoot(tmp.path, "safe"))).toBe(false)
  })

  test("refuses to copy a store while a legacy worker is alive", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, ".math", "active")
    mkdirSync(source, { recursive: true })
    const child = spawnDetached({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: tmp.path,
      logFile: path.join(tmp.path, "active-worker.log"),
    })
    try {
      writeSwarm(source, {
        projectDir: source,
        workers: {
          ses_active: {
            sessionID: "ses_active",
            pid: child.pid,
            state: "running",
            startedAt: 1,
            logFile: path.join(source, "logs", "worker.log"),
          },
        },
      })
      expect(() => migrateLegacyMathProject({ workspace: tmp.path, source: "active", problem: "safe" })).toThrow(
        "stop all legacy math workers",
      )
    } finally {
      process.kill(-child.pid, "SIGKILL")
    }
  })
})
