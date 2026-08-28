import { Database as BunDatabase } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isSQLiteLockError, withSQLiteLockRetry } from "../../src/storage/sqlite-lock"

async function waitForFile(file: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("storage.sqlite-lock", () => {
  test("recognizes SQLite lock errors across runtime error shapes", () => {
    expect(isSQLiteLockError({ code: "SQLITE_BUSY", message: "busy" })).toBe(true)
    expect(isSQLiteLockError(new Error("database is locked"))).toBe(true)
    expect(isSQLiteLockError(new Error("Failed to run the query 'begin immediate'"))).toBe(true)
    expect(isSQLiteLockError("SQLITE_LOCKED")).toBe(true)
    expect(isSQLiteLockError(new Error("outer", { cause: new Error("database is locked") }))).toBe(true)
    expect(isSQLiteLockError(new Error("constraint failed"))).toBe(false)
  })

  test("does not retry unrelated database errors", () => {
    let attempts = 0
    expect(() =>
      withSQLiteLockRetry(
        () => {
          attempts += 1
          throw new Error("constraint failed")
        },
        { operation: "non-lock regression test", attempts: 5, baseDelayMs: 0 },
      ),
    ).toThrow("constraint failed")
    expect(attempts).toBe(1)
  })

  test("retries an immediate transaction while another process owns the write lock", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-sqlite-lock-"))
    const databasePath = path.join(dir, "database.sqlite")
    const readyPath = path.join(dir, "holder.ready")
    const holderPath = path.join(import.meta.dir, "../fixture/sqlite-lock-holder.ts")
    const owner = new BunDatabase(databasePath)
    owner.run("PRAGMA journal_mode = WAL")
    owner.run("CREATE TABLE item (value INTEGER NOT NULL)")

    const holder = Bun.spawn([process.execPath, holderPath, databasePath, readyPath, "180"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    let holderExited = false
    const holderExit = holder.exited.then((code) => {
      holderExited = true
      return code
    })
    const holderStderr = holder.stderr ? new Response(holder.stderr).text() : Promise.resolve("")
    const contender = new BunDatabase(databasePath)
    const attempts: number[] = []

    try {
      await waitForFile(readyPath, 5_000)
      contender.run("PRAGMA busy_timeout = 1")

      const value = withSQLiteLockRetry(
        (attempt) => {
          attempts.push(attempt)
          contender.run("BEGIN IMMEDIATE")
          contender.run("INSERT INTO item (value) VALUES (1)")
          contender.run("COMMIT")
          return "committed"
        },
        {
          operation: "sqlite lock regression test",
          databasePath,
          attempts: 6,
          baseDelayMs: 25,
          maxDelayMs: 100,
        },
      )

      expect(value).toBe("committed")
      expect(attempts.length).toBeGreaterThan(1)
      expect(owner.query("SELECT COUNT(*) AS count FROM item").get()).toEqual({ count: 1 })
      expect(await holderExit).toBe(0)
      expect(await holderStderr).toBe("")
    } finally {
      if (!holderExited) holder.kill()
      await holderExit
      contender.close()
      owner.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
