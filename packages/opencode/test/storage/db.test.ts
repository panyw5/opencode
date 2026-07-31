import { Database as BunDatabase } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import * as UpstreamMigration from "../../src/storage/upstream-migration"
import { it } from "../lib/effect"

let Database: typeof import("../../src/storage/db").Database

const prev = process.env["OPENCODE_DISABLE_CHANNEL_DB"]

beforeAll(async () => {
  process.env["OPENCODE_DISABLE_CHANNEL_DB"] = "0"
  ;({ Database } = await import(`../../src/storage/db?test=${Date.now()}`))
})

afterAll(() => {
  if (prev === undefined) {
    delete process.env["OPENCODE_DISABLE_CHANNEL_DB"]
    return
  }
  process.env["OPENCODE_DISABLE_CHANNEL_DB"] = prev
})

describe("Database.getChannelPath", () => {
  it.effect("returns database path for the current channel", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const expected = ["latest", "beta", "prod"].includes(InstallationChannel)
        ? path.join(Global.Path.data, "opencode.db")
        : path.join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)

      expect(Database.getChannelPath(flags)).toBe(expected)
    }).pipe(Effect.provide(RuntimeFlags.layer())),
  )

  it.effect("uses the shared database path when channel databases are disabled", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(Database.getChannelPath(flags)).toBe(path.join(Global.Path.data, "opencode.db"))
    }).pipe(Effect.provide(RuntimeFlags.layer({ disableChannelDb: true }))),
  )

  it.effect("accepts RuntimeFlags with skipMigrations for database callers", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service

      expect(flags.skipMigrations).toBe(true)
      expect(Database.getChannelPath(flags)).toBe(Database.getChannelPath({ disableChannelDb: flags.disableChannelDb }))
    }).pipe(Effect.provide(RuntimeFlags.layer({ skipMigrations: true }))),
  )
})

describe("Database.Client schema repair", () => {
  it.effect("adds session_message seq when a shared database is missing it", () =>
    Effect.sync(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-db-repair-"))
      const dbPath = path.join(dir, "opencode.db")
      const previous = Flag.OPENCODE_DB

      try {
        const sqlite = new BunDatabase(dbPath, { create: true })
        sqlite.run("PRAGMA foreign_keys = OFF")
        sqlite.run("CREATE TABLE session (id text PRIMARY KEY)")
        sqlite.run(`
          CREATE TABLE session_message (
            id text PRIMARY KEY,
            session_id text NOT NULL,
            type text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            data text NOT NULL
          )
        `)
        sqlite.run("CREATE INDEX session_message_session_idx ON session_message (session_id)")
        sqlite.run("CREATE INDEX session_message_session_type_idx ON session_message (session_id, type)")
        sqlite.run("CREATE INDEX session_message_time_created_idx ON session_message (time_created)")
        sqlite.run("INSERT INTO session (id) VALUES ('session')")
        sqlite.run(`
          INSERT INTO session_message (id, session_id, type, time_created, time_updated, data)
          VALUES ('later', 'session', 'assistant', 20, 20, '{}')
        `)
        sqlite.run(`
          INSERT INTO session_message (id, session_id, type, time_created, time_updated, data)
          VALUES ('earlier', 'session', 'user', 10, 10, '{}')
        `)
        sqlite.close()

        Flag.OPENCODE_DB = dbPath
        Database.Client({ disableChannelDb: true, skipMigrations: true })

        const rows = Database.Client().$client.query("SELECT id, seq FROM session_message ORDER BY seq").all() as {
          id: string
          seq: number
        }[]
        const indexes = Database.Client().$client.query("PRAGMA index_list(session_message)").all() as {
          name: string
          unique: number
        }[]

        expect(rows).toEqual([
          { id: "earlier", seq: 0 },
          { id: "later", seq: 1 },
        ])
        expect(indexes.find((index) => index.name === "session_message_session_seq_idx")).toMatchObject({
          unique: 1,
        })
        expect(indexes.map((index) => index.name)).toContain("session_message_session_type_seq_idx")
      } finally {
        Database.close()
        Flag.OPENCODE_DB = previous
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )
})

describe("Database.Client upstream migration path", () => {
  it.effect("uses SQLite-compatible quoting for upstream migration bridge", () =>
    Effect.sync(() => {
      const tables = new Set(["session", "__drizzle_migrations"])
      const columns = new Map([
        [
          "session",
          [
            "id",
            "project_id",
            "parent_id",
            "workspace_id",
            "slug",
            "directory",
            "path",
            "title",
            "version",
            "time_created",
            "time_updated",
          ],
        ],
      ])
      const completed = new Set<string>()
      const runs: Array<{ sql: string; params: unknown[] }> = []
      const all = (sql: string, ...params: unknown[]) => {
        if (/name = "/.test(sql)) throw new Error("Node sqlite treated double-quoted table name as an identifier")
        if (sql === "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1") {
          expect(params).toHaveLength(1)
          return tables.has(String(params[0])) ? [{ name: params[0] }] : []
        }
        if (sql === "SELECT id FROM migration") return Array.from(completed, (id) => ({ id }))

        const pragma = /^PRAGMA table_info\("([A-Za-z_][A-Za-z0-9_]*)"\)$/.exec(sql)
        if (pragma) return (columns.get(pragma[1]!) ?? []).map((name) => ({ name }))

        // Post-apply invariant probes may issue extra SELECTs; treat as empty.
        if (sql.startsWith("SELECT")) return []

        throw new Error(`Unexpected SQL: ${sql}`)
      }
      const db = {
        run(sql: string, ...params: unknown[]) {
          if (/VALUES \("/.test(sql)) throw new Error("Migration id was interpolated as a double-quoted literal")
          // Phase 2: never allow destructive core-row deletes through the bridge.
          if (/DELETE\s+FROM\s+(session|message|part|event|session_message)\b/i.test(sql)) {
            throw new Error(`Forbidden destructive SQL in upstream migration: ${sql}`)
          }
          runs.push({ sql, params })
          if (sql.startsWith("CREATE TABLE IF NOT EXISTS migration")) tables.add("migration")
          if (sql.includes("INSERT OR IGNORE INTO migration") && sql.includes("SELECT name,")) {
            expect(sql).not.toContain("SELECT name, ?")
            expect(sql).toMatch(/SELECT name, \d+/)
            completed.add("20260211171708_add_project_commands")
          }
          if (sql.startsWith("ALTER TABLE session ADD metadata")) columns.get("session")?.push("metadata")
          if (sql.includes("CREATE TABLE session_input")) tables.add("session_input")
          if (sql.includes("CREATE TABLE session_context_epoch")) tables.add("session_context_epoch")
          if (sql.includes("CREATE TABLE credential")) tables.add("credential")
          if (sql.includes("CREATE TABLE project_directory")) tables.add("project_directory")
          if (sql.startsWith("INSERT OR IGNORE INTO migration") && /VALUES \('[^']+', \d+\)/.test(sql)) {
            const id = /VALUES \('([^']+)'/.exec(sql)?.[1]
            expect(id).toEqual(expect.any(String))
            if (!id) throw new Error(`Missing migration id in SQL: ${sql}`)
            completed.add(id)
          }
        },
        $client: {
          prepare(sql: string) {
            return {
              all: (...params: unknown[]) => all(sql, ...params),
            }
          },
        },
      }

      UpstreamMigration.apply(db, "/tmp/opencode.db")

      expect(runs.some((run) => /VALUES \('[^']+', \d+\)/.test(run.sql))).toBe(true)
      expect(completed).toContain("20260511173437_session-metadata")
      expect(completed).toContain("20260622202450_simplify_session_input")
      expect(completed).toContain("20260622170816_reset_v2_session_state")
      expect(runs.some((run) => /CREATE INDEX IF NOT EXISTS session_project_parent_time_idx/.test(run.sql))).toBe(
        true,
      )
      expect(runs.some((run) => /DELETE\s+FROM\s+session\b/i.test(run.sql))).toBe(false)
    }),
  )

  it.effect("seeds upstream migration journal from drizzle and preserves canonical rows", () =>
    Effect.sync(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-upstream-migration-"))
      const dbPath = path.join(dir, "opencode.db")
      const previousDb = Flag.OPENCODE_DB

      try {
        const sqlite = new BunDatabase(dbPath, { create: true })
        sqlite.run(`
          CREATE TABLE __drizzle_migrations (
            id SERIAL PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric,
            name text,
            applied_at text
          )
        `)
        sqlite.run(`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1770830228000, '20260211171708_add_project_commands', NULL)
        `)
        sqlite.run(`
          CREATE TABLE project (
            id text PRIMARY KEY,
            worktree text NOT NULL,
            sandboxes text NOT NULL
          )
        `)
        sqlite.run(`
          CREATE TABLE session (
            id text PRIMARY KEY,
            project_id text NOT NULL,
            parent_id text,
            workspace_id text,
            slug text NOT NULL,
            directory text NOT NULL,
            path text,
            title text NOT NULL,
            version text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL
          )
        `)
        sqlite.run(`
          CREATE TABLE message (
            id text PRIMARY KEY,
            session_id text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            data text NOT NULL
          )
        `)
        sqlite.run(`
          CREATE TABLE part (
            id text PRIMARY KEY,
            message_id text NOT NULL,
            session_id text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            data text NOT NULL
          )
        `)
        sqlite.run(`
          CREATE TABLE todo (
            session_id text NOT NULL,
            content text NOT NULL,
            status text NOT NULL,
            priority text NOT NULL,
            position integer NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            PRIMARY KEY(session_id, position)
          )
        `)
        sqlite.run(`
          INSERT INTO project (id, worktree, sandboxes)
          VALUES ('project', 'C:' || char(92) || 'Users' || char(92) || 'Ada' || char(92) || 'repo', '[]')
        `)
        sqlite.run(`
          INSERT INTO session (
            id, project_id, slug, directory, path, title, version, time_created, time_updated
          )
          VALUES (
            'session',
            'project',
            'slug',
            'C:' || char(92) || 'Users' || char(92) || 'Ada' || char(92) || 'repo',
            'src' || char(92) || 'index.ts',
            'Title',
            '1',
            1,
            2
          )
        `)
        sqlite.run("INSERT INTO message VALUES ('message', 'session', 3, 4, '{}')")
        sqlite.run("INSERT INTO part VALUES ('part', 'message', 'session', 5, 6, '{}')")
        sqlite.run("INSERT INTO todo VALUES ('session', 'todo', 'pending', 'high', 0, 7, 8)")
        sqlite.close()

        Flag.OPENCODE_DB = dbPath

        Database.Client({ disableChannelDb: true, skipMigrations: true })
        Database.close()
        Database.Client({ disableChannelDb: true, skipMigrations: true })

        const rows = Database.Client().$client.query("SELECT id FROM migration ORDER BY id").all() as { id: string }[]
        const sessionColumns = Database.Client().$client.query("PRAGMA table_info(session)").all() as { name: string }[]
        const sessionInputColumns = Database.Client().$client.query("PRAGMA table_info(session_input)").all() as {
          name: string
        }[]
        const contextColumns = Database.Client().$client.query("PRAGMA table_info(session_context_epoch)").all() as {
          name: string
        }[]
        const projectDirectoryColumns = Database.Client()
          .$client.query("PRAGMA table_info(project_directory)")
          .all() as { name: string }[]
        const credentialColumns = Database.Client().$client.query("PRAGMA table_info(credential)").all() as {
          name: string
        }[]
        const permissionColumns = Database.Client().$client.query("PRAGMA table_info(permission)").all() as {
          name: string
        }[]
        const counts = Database.Client()
          .$client.query(
            `
            SELECT
              (SELECT count(*) FROM session) AS session_count,
              (SELECT count(*) FROM message) AS message_count,
              (SELECT count(*) FROM part) AS part_count,
              (SELECT count(*) FROM todo) AS todo_count
          `,
          )
          .all()[0] as Record<string, number>
        const paths = Database.Client()
          .$client.query(
            "SELECT project.worktree, session.directory, session.path FROM session JOIN project ON project.id = session.project_id",
          )
          .all()[0] as { worktree: string; directory: string; path: string }

        const migrationIds = rows.map((row) => row.id)
        expect(migrationIds).toContain("20260211171708_add_project_commands")
        expect(migrationIds).toContain("20260511173437_session-metadata")
        expect(migrationIds).toContain("20260601010001_normalize_storage_paths")
        expect(migrationIds).toContain("20260601202201_amazing_prowler")
        expect(migrationIds).toContain("20260602002951_lowly_union_jack")
        expect(migrationIds).toContain("20260602182828_add_project_directories")
        expect(migrationIds).toContain("20260611035744_credential")
        expect(migrationIds).toContain("20260612174303_project_dir_strategy")
        expect(sessionColumns.map((column) => column.name)).toContain("metadata")
        expect(sessionInputColumns.map((column) => column.name)).toEqual([
          "id",
          "session_id",
          "prompt",
          "delivery",
          "admitted_seq",
          "promoted_seq",
          "time_created",
        ])
        expect(contextColumns.map((column) => column.name)).toEqual([
          "session_id",
          "baseline",
          "snapshot",
          "baseline_seq",
        ])
        expect(projectDirectoryColumns.map((column) => column.name)).toEqual([
          "project_id",
          "directory",
          "type",
          "strategy",
          "time_created",
        ])
        expect(credentialColumns.map((column) => column.name)).toEqual([
          "id",
          "integration_id",
          "label",
          "value",
          "connector_id",
          "method_id",
          "active",
          "time_created",
          "time_updated",
        ])
        // Permission table is not created by upstream ensures (fork SQL migrations own it).
        // When present it must stay json-blob; this fixture has no permission table.
        expect(permissionColumns.map((column) => column.name)).toEqual([])
        expect(counts).toEqual({
          session_count: 1,
          message_count: 1,
          part_count: 1,
          todo_count: 1,
        })
        expect(paths).toEqual({
          worktree: "C:/Users/Ada/repo",
          directory: "C:/Users/Ada/repo",
          path: "src/index.ts",
        })

        const listIndexes = Database.Client()
          .$client.query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'session_%parent_time_idx' ORDER BY name",
          )
          .all() as { name: string }[]
        expect(listIndexes.map((row) => row.name)).toEqual([
          "session_project_directory_parent_time_idx",
          "session_project_parent_time_idx",
          "session_project_path_parent_time_idx",
          "session_workspace_parent_time_idx",
        ])

        // Dual-ledger: drizzle-only name is mirrored into migration table.
        expect(migrationIds).toContain("20260211171708_add_project_commands")

        // reset_v2 must not wipe canonical rows
        expect(counts).toEqual({
          session_count: 1,
          message_count: 1,
          part_count: 1,
          todo_count: 1,
        })
      } finally {
        Database.close()
        Flag.OPENCODE_DB = previousDb
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  it.effect("syncs drizzle-only ledger names into migration without destroying rows", () =>
    Effect.sync(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-ledger-sync-"))
      const dbPath = path.join(dir, "opencode.db")
      const previousDb = Flag.OPENCODE_DB

      try {
        const sqlite = new BunDatabase(dbPath, { create: true })
        sqlite.run(`
          CREATE TABLE __drizzle_migrations (
            id INTEGER PRIMARY KEY,
            hash text NOT NULL,
            created_at numeric,
            name text,
            applied_at text
          )
        `)
        sqlite.run(`
          INSERT INTO __drizzle_migrations (hash, created_at, name)
          VALUES
            ('h1', 1, '20260528143649_session_list_indexes'),
            ('h2', 2, '20260721011749_scheduled_tasks'),
            ('h3', 3, '20260722141617_session_content_search')
        `)
        sqlite.run(`
          CREATE TABLE session (
            id text PRIMARY KEY,
            project_id text,
            parent_id text,
            directory text,
            path text,
            workspace_id text,
            time_updated integer
          )
        `)
        sqlite.run(`
          CREATE TABLE migration (
            id TEXT PRIMARY KEY,
            time_completed INTEGER NOT NULL
          )
        `)
        // Pretend upstream path already completed one id; drizzle has more.
        sqlite.run(`INSERT INTO migration (id, time_completed) VALUES ('20260528143649_session_list_indexes', 1)`)
        sqlite.run("INSERT INTO session (id, project_id, directory, time_updated) VALUES ('s1', 'p', '/tmp', 1)")
        sqlite.close()

        Flag.OPENCODE_DB = dbPath
        Database.Client({ disableChannelDb: true, skipMigrations: true })

        const ids = Database.Client()
          .$client.query("SELECT id FROM migration ORDER BY id")
          .all()
          .map((row: { id: string }) => row.id)
        const sessionCount = (
          Database.Client().$client.query("SELECT count(*) AS c FROM session").all()[0] as { c: number }
        ).c
        const indexes = Database.Client()
          .$client.query(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='session_project_parent_time_idx'",
          )
          .all() as { name: string }[]

        expect(ids).toContain("20260528143649_session_list_indexes")
        expect(ids).toContain("20260721011749_scheduled_tasks")
        expect(ids).toContain("20260722141617_session_content_search")
        expect(sessionCount).toBe(1)
        expect(indexes).toHaveLength(1)
      } finally {
        Database.close()
        Flag.OPENCODE_DB = previousDb
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )
})
