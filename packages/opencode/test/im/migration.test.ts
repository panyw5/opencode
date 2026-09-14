import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

type MigrationEntry = { name: string; timestamp: number; sql: string }

const migrationDir = path.resolve(import.meta.dir, "../../migration")

function migrationEntries(): MigrationEntry[] {
  return readdirSync(migrationDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{14}_/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      timestamp: Number(entry.name.slice(0, 14)),
      sql: readFileSync(path.join(migrationDir, entry.name, "migration.sql"), "utf8"),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

function columns(sqlite: SQLite, table: string) {
  return sqlite
    .query(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => (row as { name: string }).name)
}

function projectRow(sqlite: SQLite, id: string) {
  return sqlite.query("SELECT id, worktree FROM project WHERE id = ?").get(id) as { id: string; worktree: string } | null
}

describe("IM migration compatibility", () => {
  test("upgrades a database with historical IM rows and preserves ownership, keys, and foreign keys", () => {
    const sqlite = new SQLite(":memory:")
    const db = drizzle({ client: sqlite })
    const entries = migrationEntries()
    const base = entries.findIndex((entry) => entry.name === "20260914083850_im_transport")
    expect(base).toBeGreaterThan(0)

    migrate(db, entries.slice(0, base + 1))
    sqlite.run(
      `INSERT INTO im_message
        (id, platform, channel_name, event_id, direction, scope, conversation_id, text, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["legacy-inbound", "qq", "legacy", "event-1", "inbound", "c2c", "private:user-1", "hello", 1, 1],
    )
    sqlite.run(
      `INSERT INTO im_outbound
        (id, platform, channel_name, mode, target, text, status, provider_message_id, attempt_count, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy-send",
        "qq",
        "legacy",
        "proactive",
        JSON.stringify({ platform: "qq", channelName: "legacy", scope: "c2c", conversationID: "private:user-1" }),
        "hello",
        "sent",
        "provider-1",
        1,
        1,
        1,
      ],
    )
    sqlite.run(
      `INSERT INTO im_outbound
        (id, platform, channel_name, mode, target, text, status, provider_message_id, attempt_count, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy-send-2",
        "qq",
        "legacy",
        "proactive",
        JSON.stringify({ platform: "qq", channelName: "legacy", scope: "c2c", conversationID: "private:user-1" }),
        "hello again",
        "sent",
        "provider-2",
        1,
        2,
        2,
      ],
    )

    expect(() => migrate(db, entries.slice(base + 1))).not.toThrow()
    sqlite.run("PRAGMA foreign_keys = ON")

    expect(projectRow(sqlite, "global")).toEqual({ id: "global", worktree: "" })
    expect(sqlite.query("SELECT project_id FROM im_outbound WHERE id = ?").get("legacy-send")).toEqual({
      project_id: "global",
    })
    expect(sqlite.query("SELECT provider_sequence_key, provider_sequence FROM im_outbound WHERE id = ?").get("legacy-send")).toEqual({
      provider_sequence_key: "qq\u0000legacy\u0000c2c\u0000private:user-1\u0000proactive",
      provider_sequence: 1,
    })
    expect(sqlite.query("SELECT provider_sequence FROM im_outbound WHERE id = ?").get("legacy-send-2")).toEqual({
      provider_sequence: 2,
    })
    expect(sqlite.query("SELECT text FROM im_message WHERE id = ?").get("legacy-inbound")).toEqual({ text: "hello" })

    sqlite.run(
      "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)",
      ["project-2", "/tmp/project-2", 2, 2, "[]"],
    )
    sqlite.run(
      `INSERT INTO im_outbound
        (id, project_id, platform, channel_name, mode, target, provider_sequence_key, provider_sequence, text, status, attempt_count, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "legacy-send",
        "project-2",
        "qq",
        "legacy",
        "proactive",
        JSON.stringify({ platform: "qq", channelName: "legacy", scope: "c2c", conversationID: "private:user-1" }),
        "qq\u0000legacy\u0000c2c\u0000private:user-1\u0000proactive",
        2,
        "second project",
        "sent",
        1,
        2,
        2,
      ],
    )
    expect(sqlite.query("SELECT count(*) AS count FROM im_outbound WHERE id = ?").get("legacy-send")).toEqual({ count: 2 })
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])

    sqlite.run("DELETE FROM project WHERE id = ?", "project-2")
    expect(sqlite.query("SELECT count(*) AS count FROM im_outbound WHERE project_id = ?").get("project-2")).toEqual({
      count: 0,
    })
    expect(sqlite.query("SELECT count(*) AS count FROM im_message").get()).toEqual({ count: 1 })
    sqlite.close()
  })

  test("applies the complete production migration chain to a fresh database", () => {
    const sqlite = new SQLite(":memory:")
    const db = drizzle({ client: sqlite })
    const entries = migrationEntries()

    expect(() => migrate(db, entries)).not.toThrow()
    sqlite.run("PRAGMA foreign_keys = ON")
    expect(columns(sqlite, "im_message")).toContain("ingest_seq")
    expect(columns(sqlite, "im_outbound")).toEqual(
      expect.arrayContaining(["project_id", "provider_sequence_key", "provider_sequence"]),
    )
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'im_access'").get()).toEqual({
      name: "im_access",
    })
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    sqlite.close()
  })
})
