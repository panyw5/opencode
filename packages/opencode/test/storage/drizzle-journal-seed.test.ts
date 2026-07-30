import { Database as BunDatabase } from "bun:sqlite"
import { describe, expect } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Effect } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { it } from "../lib/effect"

describe("Database.Client drizzle journal seed", () => {
  it.effect("seeds an empty drizzle journal from the upstream migration table", () =>
    Effect.promise(async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "opencode-drizzle-seed-"))
      const dbPath = path.join(dir, "opencode.db")
      const previousDb = Flag.OPENCODE_DB
      let Database: typeof import("../../src/storage/db").Database | undefined

      try {
        const migrationNames = readdirSync(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)

        const sqlite = new BunDatabase(dbPath, { create: true })
        sqlite.run("CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)")
        sqlite.run(`
          CREATE TABLE session (
            id text PRIMARY KEY,
            project_id text NOT NULL,
            parent_id text,
            slug text NOT NULL DEFAULT '',
            directory text NOT NULL DEFAULT '',
            title text NOT NULL DEFAULT '',
            version text NOT NULL DEFAULT '',
            time_created integer NOT NULL DEFAULT 0,
            time_updated integer NOT NULL DEFAULT 0
          )
        `)
        sqlite.run("CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)")
        sqlite.run("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)")
        const insert = sqlite.prepare("INSERT INTO migration (id, time_completed) VALUES (?, 1)")
        for (const name of migrationNames) insert.run(name)
        insert.run("20260511173437_session-metadata")
        insert.run("20260601010001_normalize_storage_paths")
        insert.run("20260603001617_session_message_projection_indexes")
        insert.run("20260603040000_session_message_projection_order")
        insert.run("20260603141458_session_input_inbox")
        insert.run("20260603160727_jittery_ezekiel_stane")
        insert.run("20260604172448_event_sourced_session_input")
        insert.run("20260605003541_add_session_context_snapshot")
        insert.run("20260622142730_simplify_session_context_epoch")
        insert.run("20260622170816_reset_v2_session_state")
        insert.run("20260622202450_simplify_session_input")
        sqlite.close()

        Flag.OPENCODE_DB = dbPath
        ;({ Database } = await import(`../../src/storage/db?seed=${Date.now()}`))
        Database.Client({ disableChannelDb: true, skipMigrations: false })

        const rows = Database.Client().$client.query("SELECT name FROM __drizzle_migrations WHERE name IS NOT NULL").all() as {
          name: string
        }[]

        expect(rows.map((row) => row.name)).toContain("20260127222353_familiar_lady_ursula")
      } finally {
        Database?.close()
        Flag.OPENCODE_DB = previousDb
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        } catch {}
      }
    }),
  )
})
