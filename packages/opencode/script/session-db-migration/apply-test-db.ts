/**
 * Open the isolated test DB through Database.Client so drizzle + upstream
 * migration + repair run. Never targets production.
 *
 * Usage (from repo root):
 *   ./packages/opencode/script/session-db-migration/open-with-test-db.sh \
 *     bun packages/opencode/script/session-db-migration/apply-test-db.ts
 */
import { Database as BunDatabase } from "bun:sqlite"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"

const productionDefault = path.join(
  process.env.XDG_DATA_HOME || path.join(process.env.HOME || "", ".local/share"),
  "opencode",
  "opencode.db",
)
const production = process.env.OPENCODE_PRODUCTION_DB || productionDefault
const target = process.env.OPENCODE_DB

function abs(p: string) {
  return path.resolve(p)
}

if (!target) {
  console.error("ERROR: OPENCODE_DB must be set (use open-with-test-db.sh)")
  process.exit(1)
}
if (abs(target) === abs(production)) {
  console.error("ERROR: refusing production DB:", target)
  process.exit(1)
}
if (path.basename(target) === "opencode.db" && abs(target) === abs(production)) {
  console.error("ERROR: refusing production basename at production path")
  process.exit(1)
}

// Pre-counts via raw sqlite (before app open) for safety log.
const pre = new BunDatabase(target, { readonly: true })
const preCounts = pre
  .query(
    `
    SELECT
      (SELECT count(*) FROM session) AS session,
      (SELECT count(*) FROM message) AS message,
      (SELECT count(*) FROM part) AS part,
      (SELECT count(*) FROM event) AS event
  `,
  )
  .get() as Record<string, number>
pre.close()

console.log(JSON.stringify({ phase: "pre", db: target, counts: preCounts }, null, 2))

// Flag is read at import of storage/db via process.env / Flag module — already set by shell.
Flag.OPENCODE_DB = target

const storage = await import("../../src/storage/db.ts")
storage.Client.reset()
const client = storage.Client({ disableChannelDb: true })

const postCounts = client
  .$client.query(
    `
    SELECT
      (SELECT count(*) FROM session) AS session,
      (SELECT count(*) FROM message) AS message,
      (SELECT count(*) FROM part) AS part,
      (SELECT count(*) FROM event) AS event
  `,
  )
  .get() as Record<string, number>

const migrationCount = (
  client.$client.query("SELECT count(*) AS c FROM migration").get() as { c: number }
).c
const drizzleCount = (
  client.$client.query("SELECT count(*) AS c FROM __drizzle_migrations WHERE name IS NOT NULL").get() as {
    c: number
  }
).c
const forkIndexes = client
  .$client.query(
    `
    SELECT name FROM sqlite_master
    WHERE type = 'index'
      AND name IN (
        'session_project_parent_time_idx',
        'session_project_directory_parent_time_idx',
        'session_project_path_parent_time_idx',
        'session_workspace_parent_time_idx'
      )
    ORDER BY name
  `,
  )
  .all()
  .map((row: { name: string }) => row.name)

const tables = {
  project_directory: !!(
    client.$client.query("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='project_directory'").get() as
      | { x: number }
      | null
  ),
  credential: !!(
    client.$client.query("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='credential'").get() as
      | { x: number }
      | null
  ),
  scheduled_task: !!(
    client.$client.query("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='scheduled_task'").get() as
      | { x: number }
      | null
  ),
  session_content_fts: !!(
    client.$client
      .query("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='session_content_fts'")
      .get() as { x: number } | null
  ),
}

const permissionCols = client
  .$client.query("PRAGMA table_info(permission)")
  .all()
  .map((row: { name: string }) => row.name)

storage.close()

const lost =
  postCounts.session < preCounts.session ||
  postCounts.message < preCounts.message ||
  postCounts.part < preCounts.part ||
  postCounts.event < preCounts.event

const result = {
  phase: "post",
  db: target,
  production_untouched: abs(target) !== abs(production),
  preCounts,
  postCounts,
  lost_rows: lost,
  migrationCount,
  drizzleNamedCount: drizzleCount,
  forkIndexes,
  tables,
  permissionCols,
  ok: !lost && forkIndexes.length === 4 && tables.project_directory && tables.credential,
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(2)
