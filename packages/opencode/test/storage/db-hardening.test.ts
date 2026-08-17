import { Database as BunDatabase } from "bun:sqlite"
import { beforeEach, describe, expect } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as UpstreamMigration from "../../src/storage/upstream-migration"
import { Database } from "../../src/storage/db"
import { it } from "../lib/effect"

// The Database module is a process-wide singleton shared with every other test
// file (bun dedupes modules by path, so query-string cache busting does not
// isolate it). Reset any client a previous file loaded so each case starts
// from a clean slate.
beforeEach(() => {
  Database.close()
})

describe("Database.Client hardening", () => {
  it.effect("throws on a corrupt database file instead of silently recovering", () =>
    Effect.sync(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-db-corrupt-"))
      const dbPath = path.join(dir, "opencode.db")
      const previous = Flag.OPENCODE_DB
      const garbage = "this is not a sqlite database\n".repeat(16)

      try {
        // Document current behavior: a corrupt database aborts startup with the
        // raw SQLite error. The file is preserved so users can recover it
        // manually; there is no automatic backup/rebuild.
        writeFileSync(dbPath, garbage)

        Flag.OPENCODE_DB = dbPath
        expect(() => Database.Client({ disableChannelDb: true, skipMigrations: true })).toThrow()
        expect(Database.Client.loaded()).toBe(false)
        expect(existsSync(dbPath)).toBe(true)
        expect(readFileSync(dbPath, "utf-8")).toBe(garbage)
      } finally {
        Database.close()
        Flag.OPENCODE_DB = previous
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.effect("applies WAL, busy timeout, foreign keys and synchronous pragmas on open", () =>
    Effect.sync(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-db-pragma-"))
      const dbPath = path.join(dir, "opencode.db")
      const previous = Flag.OPENCODE_DB

      try {
        Flag.OPENCODE_DB = dbPath
        // Fresh empty database with skipMigrations: drizzle entries are
        // replaced with "select 1;" so no application tables are created.
        Database.Client({ disableChannelDb: true, skipMigrations: true })

        const pragma = (name: string) =>
          (Database.Client().$client.query(`PRAGMA ${name}`).all()[0] as Record<string, unknown>)[name]
        // PRAGMA busy_timeout reports its value under a "timeout" column.
        const busyTimeout = (Database.Client().$client.query("PRAGMA busy_timeout").all()[0] as Record<string, unknown>)["timeout"]

        expect(pragma("journal_mode")).toBe("wal")
        expect(busyTimeout).toBe(5000)
        expect(pragma("foreign_keys")).toBe(1)
        expect(pragma("synchronous")).toBe(1)

        // skipMigrations must not create application tables...
        const sessionTable = Database.Client()
          .$client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'")
          .all()
        expect(sessionTable).toEqual([])
        // ...but the migration ledger bookkeeping still exists.
        const journalTable = Database.Client()
          .$client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
          .all()
        expect(journalTable).toHaveLength(1)
      } finally {
        Database.close()
        Flag.OPENCODE_DB = previous
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.effect("seeds the drizzle journal with the baseline when only the project table exists", () =>
    Effect.sync(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-db-journal-seed-"))
      const dbPath = path.join(dir, "opencode.db")
      const previous = Flag.OPENCODE_DB

      try {
        const sqlite = new BunDatabase(dbPath, { create: true })
        sqlite.run("CREATE TABLE project (id text PRIMARY KEY)")
        sqlite.close()

        Flag.OPENCODE_DB = dbPath
        Database.Client({ disableChannelDb: true, skipMigrations: true })

        const rows = Database.Client()
          .$client.query("SELECT name FROM __drizzle_migrations WHERE name IS NOT NULL")
          .all() as { name: string }[]
        const names = rows.map((row) => row.name)

        // The fallback baseline is seeded because no `migration` ledger table
        // existed; drizzle additionally records the skipped "select 1;" entries.
        expect(names).toContain("20260127222353_familiar_lady_ursula")
      } finally {
        Database.close()
        Flag.OPENCODE_DB = previous
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.effect("converts accidental row-level permission schema back to the fork JSON blob", () =>
    Effect.sync(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-db-permission-repair-"))
      const dbPath = path.join(dir, "opencode.db")
      const previous = Flag.OPENCODE_DB

      try {
        const sqlite = new BunDatabase(dbPath, { create: true })
        sqlite.run("CREATE TABLE project (id text PRIMARY KEY)")
        sqlite.run(`
          CREATE TABLE permission (
            project_id text NOT NULL,
            action text NOT NULL,
            resource text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            PRIMARY KEY (project_id, action, resource)
          )
        `)
        sqlite.run("INSERT INTO project (id) VALUES ('proj')")
        sqlite.run("INSERT INTO permission VALUES ('proj', 'bash', 'git *', 10, 20)")
        sqlite.run("INSERT INTO permission VALUES ('proj', 'edit', '*.ts', 30, 40)")
        sqlite.close()

        Flag.OPENCODE_DB = dbPath
        Database.Client({ disableChannelDb: true, skipMigrations: true })

        const columns = Database.Client()
          .$client.query("PRAGMA table_info(permission)")
          .all()
          .map((column: { name: string }) => column.name)
        const rows = Database.Client()
          .$client.query("SELECT project_id, time_created, time_updated, data FROM permission")
          .all() as { project_id: string; time_created: number; time_updated: number; data: string }[]

        expect(columns).toEqual(["project_id", "time_created", "time_updated", "data"])
        expect(rows).toHaveLength(1)
        expect(rows[0].project_id).toBe("proj")
        expect(rows[0].time_created).toBe(10)
        expect(rows[0].time_updated).toBe(40)

        const rules = JSON.parse(rows[0].data) as { permission: string; pattern: string; action: string }[]
        expect(
          rules.sort((a, b) => a.permission.localeCompare(b.permission)),
        ).toEqual([
          { permission: "bash", pattern: "git *", action: "allow" },
          { permission: "edit", pattern: "*.ts", action: "allow" },
        ])
      } finally {
        Database.close()
        Flag.OPENCODE_DB = previous
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )
})

describe("UpstreamMigration.apply failure rollback", () => {
  it.effect("rethrows a mid-migration failure after rolling back without committing", () =>
    Effect.sync(() => {
      const tables = new Set(["session"])
      let inTx = false
      let failed = false
      let rolledBack = false
      let committedAfterFailure = false
      const runs: string[] = []

      const db = {
        run(sql: string) {
          runs.push(sql)
          if (sql === "BEGIN IMMEDIATE") {
            inTx = true
            return
          }
          if (sql === "ROLLBACK") {
            if (inTx && failed) rolledBack = true
            inTx = false
            return
          }
          if (sql === "COMMIT") {
            if (failed) committedAfterFailure = true
            inTx = false
            return
          }
          if (sql.startsWith("CREATE TABLE IF NOT EXISTS migration")) {
            tables.add("migration")
            return
          }
          // Fail on the first statement executed inside the migration
          // transaction, after any pre-transaction bookkeeping.
          if (inTx && !failed) {
            failed = true
            throw new Error("simulated mid-migration failure")
          }
        },
        $client: {
          prepare(sql: string) {
            return {
              all: (...params: unknown[]) => {
                if (sql === "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1") {
                  return tables.has(String(params[0])) ? [{ name: params[0] }] : []
                }
                if (sql === "SELECT id FROM migration") return []
                if (/^PRAGMA table_info\(/.test(sql)) return []
                if (sql.startsWith("SELECT")) return []
                throw new Error(`Unexpected SQL: ${sql}`)
              },
            }
          },
        },
      }

      expect(() => UpstreamMigration.apply(db, "/tmp/opencode.db")).toThrow("simulated mid-migration failure")
      expect(rolledBack).toBe(true)
      expect(committedAfterFailure).toBe(false)
      // The failure happens before the ledger write of the failing migration.
      expect(runs.some((sql) => sql.startsWith("INSERT OR IGNORE INTO migration (id, time_completed) VALUES ("))).toBe(
        false,
      )
    }),
  )
})
