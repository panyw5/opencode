import { Database as BunDatabase } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { existsSync, readFileSync, readdirSync } from "fs"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

const current = "20260907144648_session_favorite"
const legacy = "20260907191858_session_favorite"
const index = "session_time_favorited_idx"
const favoriteTime = 1788786545601
const folder = path.join(import.meta.dirname, "../../migration")
const entries = readdirSync(folder, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(folder, entry.name, "migration.sql")))
  .map((entry) => ({
    name: entry.name,
    timestamp: Number(entry.name.split("_")[0]),
    sql: readFileSync(path.join(folder, entry.name, "migration.sql"), "utf-8"),
  }))
  .sort((a, b) => a.timestamp - b.timestamp)

let previous: string | undefined
beforeEach(() => {
  Database.close()
  previous = Flag.OPENCODE_DB
})
afterEach(() => {
  Database.close()
  Flag.OPENCODE_DB = previous
})

function seed(dbPath: string) {
  const sqlite = new BunDatabase(dbPath, { create: true })
  migrate(
    drizzle({ client: sqlite }),
    entries.filter((entry) => entry.name !== current),
  )
  sqlite.run(
    "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project_1', '/tmp/favorite', 1, 1, '[]')",
  )
  sqlite.run(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session_1', 'project_1', 'favorite', '/tmp/favorite', 'Keep this session', 'test', 1, 1)",
  )
  return sqlite
}

function open(dbPath: string) {
  Flag.OPENCODE_DB = dbPath
  return Database.Client({ disableChannelDb: true, skipMigrations: false }).$client
}

function verify(sqlite: BunDatabase, time: number | null) {
  expect(sqlite.query("SELECT title, time_favorited FROM session WHERE id = 'session_1'").get()).toEqual({
    title: "Keep this session",
    time_favorited: time,
  })
  expect(sqlite.query(`PRAGMA index_info(${index})`).all()).toMatchObject([{ name: "time_favorited" }])
  expect(sqlite.query("SELECT name FROM __drizzle_migrations WHERE name = ?").all(current)).toEqual([{ name: current }])
  expect(sqlite.query("SELECT id FROM migration WHERE id = ?").all(current)).toEqual([{ id: current }])
}

describe("Database.Client session favorite migration", () => {
  test("migrates a new database", async () => {
    await using tmp = await tmpdir()
    const sqlite = open(path.join(tmp.path, "opencode.db"))
    expect(sqlite.query("PRAGMA table_info(session)").all()).toContainEqual(
      expect.objectContaining({ name: "time_favorited", type: "INTEGER" }),
    )
    expect(sqlite.query(`PRAGMA index_info(${index})`).all()).toMatchObject([{ name: "time_favorited" }])
  })

  test("applies the original migration when the column is absent", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "opencode.db")
    seed(dbPath).close()
    verify(open(dbPath), null)
  })

  for (const ledger of ["drizzle", "upstream", "both", "none"] as const) {
    for (const indexed of [false, true]) {
      test(`preserves an existing favorite with ${ledger} legacy ledger and index=${indexed}`, async () => {
        await using tmp = await tmpdir()
        const dbPath = path.join(tmp.path, "opencode.db")
        const sqlite = seed(dbPath)
        sqlite.run("ALTER TABLE session ADD time_favorited integer")
        sqlite.run("UPDATE session SET time_favorited = ? WHERE id = 'session_1'", [favoriteTime])
        if (indexed) sqlite.run(`CREATE INDEX ${index} ON session (time_favorited)`)
        if (ledger === "drizzle" || ledger === "both") {
          sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('', ?, ?)", [
            1788808738000,
            legacy,
          ])
        }
        if (ledger === "upstream" || ledger === "both") {
          sqlite.run("CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)")
          sqlite.run("INSERT INTO migration VALUES (?, ?)", [legacy, favoriteTime])
        }
        sqlite.close()

        verify(open(dbPath), favoriteTime)
        if (ledger !== "none") {
          expect(Database.Client().$client.query("SELECT id FROM migration WHERE id = ?").all(legacy)).toEqual([
            { id: legacy },
          ])
        }
        Database.close()
        verify(open(dbPath), favoriteTime)
      })
    }
  }

  test("rolls back index creation when recording the reconciled migration fails, then retries", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "opencode.db")
    const sqlite = seed(dbPath)
    sqlite.run("ALTER TABLE session ADD time_favorited integer")
    sqlite.run("UPDATE session SET time_favorited = ?", [favoriteTime])
    sqlite.run(
      `CREATE TRIGGER abort_favorite_migration BEFORE INSERT ON __drizzle_migrations WHEN NEW.name = '${current}' BEGIN SELECT RAISE(ABORT, 'stop favorite migration'); END`,
    )

    expect(() => open(dbPath)).toThrow()
    expect(Database.Client.loaded()).toBe(false)
    expect(sqlite.query("SELECT name FROM __drizzle_migrations WHERE name = ?").all(current)).toEqual([])
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = ?").all(index)).toEqual([])
    expect(sqlite.query("SELECT time_favorited FROM session").get()).toEqual({ time_favorited: favoriteTime })

    sqlite.run("DROP TRIGGER abort_favorite_migration")
    sqlite.close()
    verify(open(dbPath), favoriteTime)
  })

  test("does not mark an incompatible existing index as migrated", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "opencode.db")
    const sqlite = seed(dbPath)
    sqlite.run("ALTER TABLE session ADD time_favorited integer")
    sqlite.run(`CREATE INDEX ${index} ON session (time_updated)`)

    expect(() => open(dbPath)).toThrow()
    expect(Database.Client.loaded()).toBe(false)
    expect(sqlite.query("SELECT name FROM __drizzle_migrations WHERE name = ?").all(current)).toEqual([])
    expect(sqlite.query(`PRAGMA index_info(${index})`).all()).toMatchObject([{ name: "time_updated" }])
    sqlite.close()
  })
})
