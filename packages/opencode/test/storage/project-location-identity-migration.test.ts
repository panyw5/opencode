import { describe, expect, test } from "bun:test"
import { init } from "#db"
import { migrateProjectLocationIdentity, migrationName } from "@/storage/project-location-identity-migration"
import * as UpstreamMigration from "@/storage/upstream-migration"

function value(input: string) {
  return `'${input.replaceAll("'", "''")}'`
}

function sqlValue(input: string | number | null | undefined) {
  if (input === null || input === undefined) return "NULL"
  return typeof input === "number" ? String(input) : value(input)
}

function database() {
  const db = init(":memory:")
  db.run("PRAGMA foreign_keys = ON")
  db.run(`
    CREATE TABLE project_location (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      directory text NOT NULL,
      canonical_directory text NOT NULL,
      kind text NOT NULL DEFAULT 'directory',
      vcs_type text,
      vcs_state text NOT NULL DEFAULT 'none',
      worktree_root text,
      git_common_dir text,
      marker text,
      lifecycle_state text NOT NULL DEFAULT 'available',
      lifecycle_generation integer NOT NULL DEFAULT 0,
      delete_operation_id text,
      time_unavailable integer,
      time_deleted integer,
      time_created integer NOT NULL DEFAULT 0,
      time_updated integer NOT NULL DEFAULT 0,
      time_last_seen integer NOT NULL DEFAULT 0
    )
  `)
  db.run("CREATE UNIQUE INDEX project_location_canonical_directory_idx ON project_location(canonical_directory)")
  db.run(
    `CREATE TABLE session (id text PRIMARY KEY, location_id text REFERENCES project_location(id) ON DELETE SET NULL)`,
  )
  db.run(
    `CREATE TABLE scheduled_task (id text PRIMARY KEY, location_id text REFERENCES project_location(id) ON DELETE SET NULL)`,
  )
  db.run(
    `CREATE TABLE workspace (id text PRIMARY KEY, location_id text REFERENCES project_location(id) ON DELETE SET NULL)`,
  )
  db.run(
    `CREATE TABLE project_alias (id text PRIMARY KEY, source_location_id text REFERENCES project_location(id) ON DELETE SET NULL)`,
  )
  db.run(
    `CREATE TABLE permission_scope (id text PRIMARY KEY, location_id text REFERENCES project_location(id) ON DELETE CASCADE)`,
  )
  return db
}

function insertLocation(
  db: ReturnType<typeof init>,
  input: {
    id: string
    projectID: string
    directory: string
    timeLastSeen: number
    kind?: string
    vcsType?: string | null
    vcsState?: string
    worktreeRoot?: string | null
    gitCommonDir?: string | null
    marker?: string | null
    lifecycleState?: string
    lifecycleGeneration?: number
    timeCreated?: number
    timeUpdated?: number
    timeUnavailable?: number | null
    timeDeleted?: number | null
  },
) {
  db.run(
    `INSERT INTO project_location (id, project_id, directory, canonical_directory, kind, vcs_type, vcs_state, worktree_root, git_common_dir, marker, lifecycle_state, lifecycle_generation, time_unavailable, time_deleted, time_created, time_updated, time_last_seen) VALUES (${sqlValue(input.id)}, ${sqlValue(input.projectID)}, ${sqlValue(input.directory)}, ${sqlValue(input.directory)}, ${sqlValue(input.kind ?? "directory")}, ${sqlValue(input.vcsType)}, ${sqlValue(input.vcsState ?? "none")}, ${sqlValue(input.worktreeRoot)}, ${sqlValue(input.gitCommonDir)}, ${sqlValue(input.marker)}, ${sqlValue(input.lifecycleState ?? "available")}, ${sqlValue(input.lifecycleGeneration ?? 0)}, ${sqlValue(input.timeUnavailable)}, ${sqlValue(input.timeDeleted)}, ${sqlValue(input.timeCreated ?? 1)}, ${sqlValue(input.timeUpdated ?? 1)}, ${sqlValue(input.timeLastSeen)})`,
  )
}

describe("project location identity migration", () => {
  test("normalizes Windows identity and rewires every location reference", () => {
    const db = database()
    insertLocation(db, { id: "location_old", projectID: "project_a", directory: "D:/Chat", timeLastSeen: 1 })
    insertLocation(db, { id: "location_new", projectID: "project_a", directory: "d:\\chat\\", timeLastSeen: 2 })
    db.run("INSERT INTO session VALUES ('session_1', 'location_old')")
    db.run("INSERT INTO scheduled_task VALUES ('task_1', 'location_old')")
    db.run("INSERT INTO workspace VALUES ('workspace_1', 'location_old')")
    db.run("INSERT INTO project_alias VALUES ('alias_1', 'location_old')")
    db.run("INSERT INTO permission_scope VALUES ('scope_1', 'location_old')")

    const result = migrateProjectLocationIdentity(db, { platform: "win32", kind: "local-filesystem" })

    expect(result).toEqual({ skipped: false, scanned: 2, normalized: 1, mergedLocations: 1, rewiredReferences: 5 })
    expect(db.$client.query("SELECT id, canonical_directory FROM project_location").all()).toEqual([
      { id: "location_new", canonical_directory: "d:/chat" },
    ])
    for (const table of ["session", "scheduled_task", "workspace"]) {
      expect(db.$client.query(`SELECT location_id FROM ${table}`).all()).toEqual([{ location_id: "location_new" }])
    }
    expect(db.$client.query("SELECT source_location_id FROM project_alias").all()).toEqual([
      { source_location_id: "location_new" },
    ])
    expect(db.$client.query("SELECT location_id FROM permission_scope").all()).toEqual([
      { location_id: "location_new" },
    ])

    const second = migrateProjectLocationIdentity(db, { platform: "win32", kind: "local-filesystem" })
    expect(second).toEqual({ skipped: false, scanned: 1, normalized: 0, mergedLocations: 0, rewiredReferences: 0 })
  })

  test("merges drive-root and UNC spelling variants", () => {
    const db = database()
    insertLocation(db, { id: "drive_root_a", projectID: "project_drive", directory: "D:/", timeLastSeen: 1 })
    insertLocation(db, { id: "drive_root_b", projectID: "project_drive", directory: "d:\\", timeLastSeen: 2 })
    insertLocation(db, {
      id: "unc_a",
      projectID: "project_unc",
      directory: "\\\\SERVER\\Share\\Repo",
      timeLastSeen: 1,
    })
    insertLocation(db, {
      id: "unc_b",
      projectID: "project_unc",
      directory: "//server/share/repo/",
      timeLastSeen: 2,
    })

    const result = migrateProjectLocationIdentity(db, { platform: "win32", kind: "local-filesystem" })

    expect(result.mergedLocations).toBe(2)
    expect(db.$client.query("SELECT canonical_directory FROM project_location ORDER BY canonical_directory").all()).toEqual([
      { canonical_directory: "//server/share/repo" },
      { canonical_directory: "d:/" },
    ])
  })

  test("rejects cross-project identity conflicts before any write", () => {
    const db = database()
    insertLocation(db, { id: "location_a", projectID: "project_a", directory: "D:/Shared", timeLastSeen: 1 })
    insertLocation(db, { id: "location_b", projectID: "project_b", directory: "d:\\shared\\", timeLastSeen: 2 })
    db.run("INSERT INTO session VALUES ('session_1', 'location_a')")

    expect(() => migrateProjectLocationIdentity(db, { platform: "win32", kind: "local-filesystem" })).toThrow(
      "Project location identity conflict across projects",
    )
    expect(db.$client.query("SELECT id, canonical_directory FROM project_location ORDER BY id").all()).toEqual([
      { id: "location_a", canonical_directory: "D:/Shared" },
      { id: "location_b", canonical_directory: "d:\\shared\\" },
    ])
    expect(db.$client.query("SELECT location_id FROM session").all()).toEqual([{ location_id: "location_a" }])
  })

  test("keeps the best survivor while merging metadata and timestamp history", () => {
    const db = database()
    insertLocation(db, {
      id: "location_available",
      projectID: "project_a",
      directory: "D:/Metadata",
      timeLastSeen: 10,
      kind: "directory",
      vcsState: "none",
      lifecycleState: "available",
      lifecycleGeneration: 1,
      timeCreated: 10,
      timeUpdated: 20,
    })
    insertLocation(db, {
      id: "location_git",
      projectID: "project_a",
      directory: "d:\\metadata\\",
      timeLastSeen: 100,
      kind: "git_main",
      vcsType: "git",
      vcsState: "ready",
      worktreeRoot: "D:\\Metadata",
      gitCommonDir: "D:\\Metadata\\.git",
      marker: "D:\\Metadata\\.git\\opencode",
      lifecycleState: "unavailable",
      lifecycleGeneration: 4,
      timeUnavailable: 90,
      timeCreated: 1,
      timeUpdated: 200,
    })

    const result = migrateProjectLocationIdentity(db, { platform: "win32", kind: "local-filesystem" })

    expect(result.mergedLocations).toBe(1)
    expect(db.$client.query("SELECT * FROM project_location").all()).toEqual([
      expect.objectContaining({
        id: "location_available",
        directory: "D:/Metadata",
        canonical_directory: "d:/metadata",
        kind: "git_main",
        vcs_type: "git",
        vcs_state: "ready",
        worktree_root: "D:/Metadata",
        git_common_dir: "D:/Metadata/.git",
        marker: "D:/Metadata/.git/opencode",
        lifecycle_state: "available",
        lifecycle_generation: 4,
        time_unavailable: null,
        time_deleted: null,
        time_created: 1,
        time_updated: 200,
        time_last_seen: 100,
      }),
    ])
  })

  test("rolls back rewiring and deletion when the enclosing migration transaction fails", () => {
    const db = database()
    insertLocation(db, { id: "location_old", projectID: "project_a", directory: "D:/Rollback", timeLastSeen: 1 })
    insertLocation(db, { id: "location_new", projectID: "project_a", directory: "d:\\rollback\\", timeLastSeen: 2 })
    db.run("INSERT INTO session VALUES ('session_1', 'location_old')")
    db.run(
      "CREATE TRIGGER abort_location_delete BEFORE DELETE ON project_location BEGIN SELECT RAISE(ABORT, 'stop migration'); END",
    )

    db.run("BEGIN IMMEDIATE")
    expect(() => migrateProjectLocationIdentity(db, { platform: "win32", kind: "local-filesystem" })).toThrow(
      "Failed to run the query",
    )
    db.run("ROLLBACK")

    expect(db.$client.query("SELECT id FROM project_location ORDER BY id").all()).toEqual([
      { id: "location_new" },
      { id: "location_old" },
    ])
    expect(db.$client.query("SELECT location_id FROM session").all()).toEqual([{ location_id: "location_old" }])
  })

  test("skips non-Windows and remote contexts without changing canonical data", () => {
    const db = database()
    insertLocation(db, { id: "location_a", projectID: "project_a", directory: "/Workspace", timeLastSeen: 1 })

    expect(migrateProjectLocationIdentity(db, { platform: "linux", kind: "local-filesystem" })).toEqual({
      skipped: true,
      scanned: 0,
      normalized: 0,
      mergedLocations: 0,
      rewiredReferences: 0,
    })
    expect(migrateProjectLocationIdentity(db, { platform: "win32", kind: "remote-filesystem" })).toEqual({
      skipped: true,
      scanned: 0,
      normalized: 0,
      mergedLocations: 0,
      rewiredReferences: 0,
    })
    expect(db.$client.query("SELECT canonical_directory FROM project_location").all()).toEqual([
      { canonical_directory: "/Workspace" },
    ])
  })

  test("does not ledger a Windows-only migration on a POSIX database", () => {
    const db = init(":memory:")
    db.run("CREATE TABLE session (id text PRIMARY KEY, metadata text)")

    UpstreamMigration.apply(db, "/tmp/posix.db", {
      pathContext: { platform: "linux", kind: "local-filesystem" },
    })

    expect(
      db.$client.query("SELECT id FROM migration WHERE id = ?").all("20260907000000_project_location_identity_win32"),
    ).toEqual([])
  })

  test("rolls back the data and migration marker together, then retries", () => {
    const db = database()
    UpstreamMigration.apply(db, "/tmp/identity-ledger.db", {
      pathContext: { platform: "linux", kind: "local-filesystem" },
    })
    insertLocation(db, { id: "location_old", projectID: "project_a", directory: "D:/Ledger", timeLastSeen: 1 })
    insertLocation(db, { id: "location_new", projectID: "project_a", directory: "d:\\ledger\\", timeLastSeen: 2 })
    db.run("INSERT INTO session (id, location_id) VALUES ('session_ledger', 'location_old')")
    db.run(
      "CREATE TRIGGER abort_identity_delete BEFORE DELETE ON project_location BEGIN SELECT RAISE(ABORT, 'stop migration'); END",
    )

    expect(() =>
      UpstreamMigration.apply(db, "/tmp/identity-ledger.db", {
        pathContext: { platform: "win32", kind: "local-filesystem" },
      }),
    ).toThrow()
    expect(db.$client.query("SELECT id FROM project_location ORDER BY id").all()).toEqual([
      { id: "location_new" },
      { id: "location_old" },
    ])
    expect(db.$client.query("SELECT location_id FROM session WHERE id = 'session_ledger'").all()).toEqual([
      { location_id: "location_old" },
    ])
    expect(db.$client.query("SELECT id FROM migration WHERE id = ?").all(migrationName)).toEqual([])

    db.run("DROP TRIGGER abort_identity_delete")
    UpstreamMigration.apply(db, "/tmp/identity-ledger.db", {
      pathContext: { platform: "win32", kind: "local-filesystem" },
    })

    expect(db.$client.query("SELECT id FROM migration WHERE id = ?").all(migrationName)).toEqual([
      { id: migrationName },
    ])
    expect(db.$client.query("SELECT id, canonical_directory FROM project_location").all()).toEqual([
      { id: "location_new", canonical_directory: "d:/ledger" },
    ])
    expect(db.$client.query("SELECT location_id FROM session WHERE id = 'session_ledger'").all()).toEqual([
      { location_id: "location_new" },
    ])
  })
})
