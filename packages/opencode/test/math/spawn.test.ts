import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { Database } from "bun:sqlite"
import { killProcessGroup, pidAlive, spawnDetached } from "../../src/math/spawn"
import { readSwarm, stopPath } from "../../src/math/swarm"
import { tmpdir } from "../fixture/fixture"

function waitUntil(pred: () => boolean, timeoutMs: number, label: string) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return
    spawnSync("sleep", ["0.05"])
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe("math.spawn", () => {
  test("detached sleep survives unref and is killable by process group", async () => {
    await using tmp = await tmpdir()
    const logFile = path.join(tmp.path, "sleep.log")
    const { pid } = spawnDetached({
      argv: ["/bin/sleep", "30"],
      cwd: tmp.path,
      logFile,
    })
    expect(pidAlive(pid)).toBe(true)
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      killProcessGroup(pid, "SIGTERM")
    }
    waitUntil(() => {
      const ps = spawnSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" })
      const state = (ps.stdout ?? "").trim()
      return ps.status !== 0 || state === "" || state.startsWith("Z")
    }, 3000, "sleep pid to die")
  })
})

describe("math.detach-probe", () => {
  test(
    "worker process stays alive and session parts grow after parent exits",
    async () => {
      await using tmp = await tmpdir({ git: true })
      const dbPath = path.join(tmp.path, "opencode.db")
      const mathRoot = path.join(tmp.path, ".math", "default")
      mkdirSync(path.join(mathRoot, "logs"), { recursive: true })

      const helper = path.join(import.meta.dir, "spawn-and-die.ts")
      const spawned = spawnSync(process.execPath, [helper, tmp.path, dbPath, "200"], {
        cwd: tmp.path,
        env: {
          ...process.env,
          OPENCODE_DB: dbPath,
          OPENCODE_PURE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_AUTOCOMPACT: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        },
        encoding: "utf8",
      })
      if (spawned.status !== 0) {
        throw new Error(`spawn-and-die failed: ${spawned.stderr || spawned.stdout}`)
      }
      const { pid } = JSON.parse(spawned.stdout.trim()) as { pid: number }
      expect(pid).toBeGreaterThan(0)

      waitUntil(() => pidAlive(pid), 15_000, "worker pid")
      const bootLog = path.join(mathRoot, "logs", "worker-boot.log")
      try {
        waitUntil(() => {
          try {
            return Object.keys(readSwarm(mathRoot).workers).length > 0
          } catch {
            return false
          }
        }, 25_000, "swarm.json workers")
      } catch (error) {
        const logText = existsSync(bootLog) ? readFileSync(bootLog, "utf8") : "(no worker-boot.log)"
        throw new Error(`${String(error)}\n--- worker-boot.log ---\n${logText}`)
      }

      const sessionID = Object.keys(readSwarm(mathRoot).workers)[0]
      expect(sessionID.startsWith("ses")).toBe(true)
      expect(pidAlive(pid)).toBe(true)

      const countParts = () => {
        try {
          const db = new Database(dbPath, { readonly: true })
          const row = db.query("select count(*) as c from part").get() as { c: number } | undefined
          db.close()
          return row?.c ?? 0
        } catch {
          return 0
        }
      }

      waitUntil(() => countParts() >= 1, 20_000, "first heartbeat part")
      const first = countParts()
      waitUntil(() => countParts() > first, 10_000, "heartbeat growth")
      expect(pidAlive(pid)).toBe(true)

      writeFileSync(stopPath(mathRoot, sessionID), `${Date.now()}\n`)
      waitUntil(() => !pidAlive(pid), 10_000, "worker exit after .stop")
    },
    60_000,
  )
})
