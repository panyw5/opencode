import { beforeEach, describe, expect, test } from "bun:test"
import { DataMigrationTable } from "@/data-migration.sql"
import { ProjectOwnershipMigration } from "@/project/ownership-migration"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"

const now = 1_780_000_000_000

function raw(sql: string) {
  Database.Client().run(sql)
}

function value(input: string) {
  return `'${input.replaceAll("'", "''")}'`
}

function seed(input: {
  path: string
  sourceIDs?: string[]
  suffix: string
  foreignSession?: boolean
  projectTask?: boolean
}) {
  const sourceIDs = input.sourceIDs ?? [`dir:legacy-${input.suffix}`]
  const targetID = `project_target_${input.suffix}`
  const locationID = `location_target_${input.suffix}`
  const sessionID = `ses_${input.suffix}`
  const scheduledTaskID = `scheduled_${input.suffix}`
  const workspaceID = `workspace_${input.suffix}`

  for (const sourceID of sourceIDs) {
    raw(
      `INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (${value(sourceID)}, ${value(input.path)}, NULL, ${now}, ${now}, '[]')`,
    )
  }
  raw(
    `INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (${value(targetID)}, ${value(input.path)}, 'git', ${now}, ${now}, '[]')`,
  )
  raw(
    `INSERT INTO project_location (id, project_id, directory, canonical_directory, kind, vcs_type, vcs_state, worktree_root, git_common_dir, marker, time_created, time_updated, time_last_seen) VALUES (${value(locationID)}, ${value(targetID)}, ${value(input.path)}, ${value(input.path)}, 'git_main', 'git', 'ready', ${value(input.path)}, ${value(`${input.path}/.git`)}, ${value(`${input.path}/.git/opencode`)}, ${now}, ${now}, ${now})`,
  )
  raw(
    `INSERT INTO project_alias (id, project_id, kind, value, confidence, source_location_id, time_created, time_updated, time_last_seen) VALUES (${value(`alias_${input.suffix}`)}, ${value(targetID)}, 'git_marker', ${value(targetID)}, 'high', ${value(locationID)}, ${now}, ${now}, ${now})`,
  )

  const sourceID = sourceIDs[0]
  if (input.projectTask) {
    raw(
      `INSERT INTO project_task (id, project_id, title, description, status, time_created, time_updated) VALUES (${value(`ptask_${input.suffix}`)}, ${value(sourceID)}, 'task', '', 'open', ${now}, ${now})`,
    )
  }
  raw(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${value(sessionID)}, ${value(sourceID)}, 'slug', ${value(input.path)}, 'session', 'test', ${now}, ${now})`,
  )
  raw(
    `INSERT INTO scheduled_task (id, project_id, directory, name, prompt, schedule_kind, schedule_value, execution_mode, agent, model, enabled, unattended, next_run_at, time_created, time_updated) VALUES (${value(scheduledTaskID)}, ${value(sourceID)}, ${value(input.path)}, 'scheduled', 'prompt', 'every', '60000', 'new_session', 'build', '{"providerID":"test","modelID":"test"}', 1, 1, ${now + 60_000}, ${now}, ${now})`,
  )
  raw(
    `INSERT INTO workspace (id, type, name, directory, project_id, time_used) VALUES (${value(workspaceID)}, 'local', '', ${value(input.path)}, ${value(sourceID)}, ${now})`,
  )
  if (input.foreignSession) {
    raw(
      `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (${value(`ses_foreign_${input.suffix}`)}, ${value(sourceID)}, 'foreign', ${value(`${input.path}-other`)}, 'foreign', 'test', ${now}, ${now})`,
    )
  }

  return { sourceIDs, targetID, locationID, sessionID, scheduledTaskID, workspaceID }
}

function owner(table: string, id: string) {
  return Database.Client().$client.query(`SELECT project_id, location_id FROM ${table} WHERE id = ?`).get(id) as {
    project_id: string
    location_id: string | null
  }
}

beforeEach(() => {
  raw("DROP TRIGGER IF EXISTS ownership_abort")
  raw("DELETE FROM project WHERE id LIKE 'project_target_%'")
  raw("DELETE FROM project WHERE id LIKE 'dir:legacy-%' OR id LIKE 'dir:ambiguous-%'")
  Database.use((db) =>
    db.delete(DataMigrationTable).where(eq(DataMigrationTable.name, ProjectOwnershipMigration.migrationName)).run(),
  )
})

describe("duplicate worktree ownership migration", () => {
  test("moves exact-directory resources atomically and preserves timestamps", () => {
    const seeded = seed({ path: "/tmp/ownership-safe", suffix: "safe" })

    const first = ProjectOwnershipMigration.runDuplicateWorktreeOwnershipMigration()

    expect(first).toMatchObject({
      completed: true,
      candidates: 1,
      migratedProjects: 1,
      skippedProjects: 0,
      sessions: 1,
      scheduledTasks: 1,
      workspaces: 1,
    })
    expect(owner("session", seeded.sessionID)).toEqual({ project_id: seeded.targetID, location_id: seeded.locationID })
    expect(owner("scheduled_task", seeded.scheduledTaskID)).toEqual({
      project_id: seeded.targetID,
      location_id: seeded.locationID,
    })
    expect(owner("workspace", seeded.workspaceID)).toEqual({
      project_id: seeded.targetID,
      location_id: seeded.locationID,
    })
    expect(
      Database.Client()
        .$client.query("SELECT time_created, time_updated FROM session WHERE id = ?")
        .get(seeded.sessionID),
    ).toEqual({ time_created: now, time_updated: now })
    expect(
      Database.Client()
        .$client.query("SELECT next_run_at, time_created, time_updated FROM scheduled_task WHERE id = ?")
        .get(seeded.scheduledTaskID),
    ).toEqual({ next_run_at: now + 60_000, time_created: now, time_updated: now })

    expect(ProjectOwnershipMigration.runDuplicateWorktreeOwnershipMigration()).toEqual({
      completed: true,
      candidates: 0,
      migratedProjects: 0,
      skippedProjects: 0,
      sessions: 0,
      scheduledTasks: 0,
      workspaces: 0,
    })
  })

  test("rejects ambiguous legacy projects without moving any rows", () => {
    const seeded = seed({
      path: "/tmp/ownership-ambiguous",
      sourceIDs: ["dir:ambiguous-a", "dir:ambiguous-b"],
      suffix: "ambiguous",
    })

    const result = ProjectOwnershipMigration.runDuplicateWorktreeOwnershipMigration()

    expect(result).toMatchObject({ completed: true, candidates: 2, migratedProjects: 0, skippedProjects: 2 })
    expect(owner("session", seeded.sessionID)).toEqual({ project_id: seeded.sourceIDs[0], location_id: null })
  })

  test("rejects a legacy project that owns resources in another directory", () => {
    const seeded = seed({ path: "/tmp/ownership-spanning", suffix: "spanning", foreignSession: true })

    const result = ProjectOwnershipMigration.runDuplicateWorktreeOwnershipMigration()

    expect(result).toMatchObject({ completed: true, candidates: 1, migratedProjects: 0, skippedProjects: 1 })
    expect(owner("session", seeded.sessionID)).toEqual({ project_id: seeded.sourceIDs[0], location_id: null })
  })

  test("rejects project-scoped tasks that have no unique location evidence", () => {
    const seeded = seed({ path: "/tmp/ownership-project-task", suffix: "project_task", projectTask: true })

    const result = ProjectOwnershipMigration.runDuplicateWorktreeOwnershipMigration()

    expect(result).toMatchObject({ completed: true, candidates: 1, migratedProjects: 0, skippedProjects: 1 })
    expect(owner("session", seeded.sessionID)).toEqual({ project_id: seeded.sourceIDs[0], location_id: null })
  })

  test("rolls back every ownership write and completion marker after a failure", () => {
    const seeded = seed({ path: "/tmp/ownership-rollback", suffix: "rollback" })
    raw(
      `CREATE TRIGGER ownership_abort BEFORE UPDATE ON scheduled_task BEGIN SELECT RAISE(ABORT, 'stop migration'); END`,
    )

    expect(() => ProjectOwnershipMigration.runDuplicateWorktreeOwnershipMigration()).toThrow("stop migration")

    expect(owner("session", seeded.sessionID)).toEqual({ project_id: seeded.sourceIDs[0], location_id: null })
    expect(
      Database.use((db) =>
        db
          .select({ name: DataMigrationTable.name })
          .from(DataMigrationTable)
          .where(eq(DataMigrationTable.name, ProjectOwnershipMigration.migrationName))
          .get(),
      ),
    ).toBeUndefined()

    raw("DROP TRIGGER ownership_abort")
    expect(ProjectOwnershipMigration.runDuplicateWorktreeOwnershipMigration()).toMatchObject({
      completed: true,
      migratedProjects: 1,
    })
  })
})
