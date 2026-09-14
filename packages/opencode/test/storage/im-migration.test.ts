import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { readFileSync } from "node:fs"
import path from "node:path"

const migration = (name: string) =>
  readFileSync(path.resolve(import.meta.dir, `../../migration/${name}/migration.sql`), "utf8")

describe("IM migration compatibility", () => {
  test("adds project-scoped outbound state when legacy rows already exist", () => {
    const db = new SQLite(":memory:")
    db.run(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE project (
        id text PRIMARY KEY,
        worktree text NOT NULL,
        visibility text NOT NULL DEFAULT 'user',
        sandboxes text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL
      );
    `)
    db.run(migration("20260914083850_im_transport"))
    db.run(`INSERT INTO im_outbound (id, platform, channel_name, mode, target, text, status, time_created, time_updated)
      VALUES ('legacy-send', 'qq', 'legacy', 'reply', '{}', 'hello', 'unknown', 1, 1)`)
    expect(() => db.run(migration("20260914085735_im_outbound_scope"))).not.toThrow()
    expect(db.query("SELECT project_id FROM im_outbound WHERE id='legacy-send'").get()).toEqual({ project_id: "global" })
    db.close()
  })
})
