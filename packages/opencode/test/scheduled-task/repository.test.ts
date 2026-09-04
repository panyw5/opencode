import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database, eq } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { Project } from "@/project/project"
import { LocationID, ProjectID } from "@/project/schema"
import { ProjectLocationTable } from "@/project/location.sql"
import { ScheduledTaskRepository } from "@/scheduled-task/repository"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@/scheduled-task/scheduled-task.sql"
import { WorkspaceTable } from "@/control-plane/workspace.sql"
import { WorkspaceID } from "@/control-plane/schema"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { Identifier } from "@/id/id"

const now = 1_700_000_000_000

function project(name: string) {
  const id = ProjectID.make(`scheduled-task-${name}-${crypto.randomUUID()}`)
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id,
        worktree: `/tmp/${name}`,
        name,
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
  return id
}

function create(
  projectID: ProjectID,
  input?: { at?: number; enabled?: boolean; directory?: string; locationID?: LocationID },
) {
  return Effect.runPromise(
    ScheduledTaskRepository.create(
      {
        projectID,
        locationID: input?.locationID,
        projectName: "Scheduled project",
        directory: input?.directory ?? "/tmp/scheduled-project",
        name: "Nightly review",
        prompt: "Review the workspace",
        schedule: { kind: "at", at: input?.at ?? now + 60_000 },
        executionMode: "new_session",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        enabled: input?.enabled,
        unattended: true,
      },
      now,
    ),
  )
}

function ensureGlobal() {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: ProjectID.global,
        worktree: "/",
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
      .onConflictDoNothing()
      .run(),
  )
}

beforeEach(() => {
  Database.use((db) => {
    db.delete(ScheduledTaskRunTable).run()
    db.delete(ScheduledTaskTable).run()
  })
})

describe("ScheduledTaskRepository", () => {
  test("persists an optional location without changing the public task shape", async () => {
    const projectID = project("location")
    const locationID = LocationID.ascending()
    const directory = `/tmp/location-${crypto.randomUUID()}`
    Database.use((db) =>
      db
        .insert(ProjectLocationTable)
        .values({
          id: locationID,
          project_id: projectID,
          directory,
          canonical_directory: directory,
          kind: "directory",
          vcs_state: "none",
          time_created: now,
          time_updated: now,
          time_last_seen: now,
        })
        .run(),
    )

    const task = await create(projectID, { directory, locationID })
    const row = Database.use((db) =>
      db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, task.id)).get(),
    )
    expect(row?.location_id).toBe(locationID)
    expect("locationID" in task).toBe(false)
  })

  test("creates, filters, updates, and removes tasks", async () => {
    const one = project("one")
    const two = project("two")
    const firstLocation = LocationID.ascending()
    const secondLocation = LocationID.ascending()
    Database.use((db) =>
      db
        .insert(ProjectLocationTable)
        .values([
          {
            id: firstLocation,
            project_id: one,
            directory: `/tmp/one-${firstLocation}`,
            canonical_directory: `/tmp/one-${firstLocation}`,
            kind: "directory",
            vcs_state: "none",
            time_created: now,
            time_updated: now,
            time_last_seen: now,
          },
          {
            id: secondLocation,
            project_id: two,
            directory: `/tmp/two-${secondLocation}`,
            canonical_directory: `/tmp/two-${secondLocation}`,
            kind: "directory",
            vcs_state: "none",
            time_created: now,
            time_updated: now,
            time_last_seen: now,
          },
        ])
        .run(),
    )
    const first = await create(one, { locationID: firstLocation })
    await create(two, { locationID: secondLocation })
    await create(one)

    expect((await Effect.runPromise(ScheduledTaskRepository.list())).map((task) => task.id)).toHaveLength(3)
    expect(await Effect.runPromise(ScheduledTaskRepository.list({ locationID: firstLocation }))).toEqual([first])
    expect(await Effect.runPromise(ScheduledTaskRepository.list({ locationID: secondLocation }))).toHaveLength(1)
    expect(await Effect.runPromise(ScheduledTaskRepository.list({ projectID: one }))).toHaveLength(2)

    const updated = await Effect.runPromise(
      ScheduledTaskRepository.update(first.id, { name: "Updated review", enabled: false }, now + 1),
    )
    expect(updated?.name).toBe("Updated review")
    expect(updated?.enabled).toBe(false)
    expect(updated?.nextRunAt).toBeUndefined()
    expect(await Effect.runPromise(ScheduledTaskRepository.remove(first.id))).toBe(true)
    expect(await Effect.runPromise(ScheduledTaskRepository.get(first.id))).toBeUndefined()
  })

  test("claims only matching legacy tasks without changing schedule or run state", async () => {
    ensureGlobal()
    const target = project("legacy-target")
    const directory = `/tmp/legacy-${crypto.randomUUID()}`
    const persistedDirectory = directory.replaceAll("/", "\\")
    const otherDirectory = `/tmp/legacy-other-${crypto.randomUUID()}`
    const task = await create(ProjectID.global, { at: now, directory: persistedDirectory })
    const other = await create(ProjectID.global, { at: now + 1, directory: otherDirectory })
    const workspaceID = WorkspaceID.ascending()
    Database.use((db) =>
      db
        .insert(WorkspaceTable)
        .values({
          id: workspaceID,
          type: "local",
          directory: persistedDirectory,
          project_id: ProjectID.global,
          time_used: now,
        })
        .run(),
    )
    const occurrence = await Effect.runPromise(
      ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: now,
        ownerID: "legacy-owner",
        leaseUntil: now + 60_000,
        now,
      }),
    )
    expect(occurrence.type).toBe("claimed")

    const beforeTask = Database.use((db) =>
      db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, task.id)).get(),
    )
    const beforeRuns = Database.use((db) =>
      db.select().from(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.task_id, task.id)).all(),
    )

    expect(Project.claimLegacyDirectory({ directory, projectID: target })).toEqual({
      sessions: 0,
      scheduledTasks: 1,
      workspaces: 1,
    })
    expect(Project.claimLegacyDirectory({ directory, projectID: target }).scheduledTasks).toBe(0)

    const afterTask = Database.use((db) =>
      db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, task.id)).get(),
    )
    const afterRuns = Database.use((db) =>
      db.select().from(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.task_id, task.id)).all(),
    )
    expect(afterTask).toEqual({ ...beforeTask, project_id: target })
    expect(afterRuns).toEqual(beforeRuns)
    expect((await Effect.runPromise(ScheduledTaskRepository.get(other.id)))?.projectID).toBe(ProjectID.global)
    const workspace = Database.use((db) =>
      db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, workspaceID)).get(),
    )
    expect(workspace?.project_id).toBe(target)
  })

  test("backfills a missing location without changing an existing project identity", async () => {
    const projectID = project("location-backfill")
    const directory = `/tmp/location-backfill-${crypto.randomUUID()}`
    const locationID = LocationID.ascending()
    Database.use((db) =>
      db
        .insert(ProjectLocationTable)
        .values({
          id: locationID,
          project_id: projectID,
          directory,
          canonical_directory: directory,
          kind: "directory",
          vcs_state: "none",
          time_created: now,
          time_updated: now,
          time_last_seen: now,
        })
        .run(),
    )
    const task = await create(projectID, { directory })

    expect(Project.claimLegacyDirectory({ directory, projectID, locationID }).scheduledTasks).toBe(1)
    expect(Project.claimLegacyDirectory({ directory, projectID, locationID }).scheduledTasks).toBe(0)

    const row = Database.use((db) =>
      db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, task.id)).get(),
    )
    expect(row?.project_id).toBe(projectID)
    expect(row?.location_id).toBe(locationID)
  })

  test("deduplicates occurrences and records same-task overlap as skipped", async () => {
    const task = await create(project("overlap"))
    const first = await Effect.runPromise(
      ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: now,
        ownerID: "owner-a",
        leaseUntil: now + 60_000,
        now,
      }),
    )
    expect(first.type).toBe("claimed")

    const duplicate = await Effect.runPromise(
      ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: now,
        ownerID: "owner-b",
        leaseUntil: now + 60_000,
        now,
      }),
    )
    expect(duplicate.type).toBe("duplicate")

    const overlap = await Effect.runPromise(
      ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: now + 1,
        ownerID: "owner-b",
        leaseUntil: now + 60_000,
        now,
      }),
    )
    expect(overlap.type).toBe("overlap")
    if (overlap.type === "overlap") expect(overlap.run.status).toBe("skipped")
  })

  test("takes over an expired lease and validates the current owner on finish", async () => {
    const task = await create(project("lease"))
    const sessionID = SessionID.make(Identifier.ascending("session"))
    Database.use((db) =>
      db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: task.projectID,
          slug: "scheduled-recovery",
          directory: task.directory,
          title: "Scheduled recovery",
          version: "test",
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
    const first = await Effect.runPromise(
      ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: now,
        ownerID: "owner-a",
        leaseUntil: now + 100,
        now,
      }),
    )
    if (first.type !== "claimed") throw new Error("expected initial claim")
    expect(
      await Effect.runPromise(
        ScheduledTaskRepository.bindSession({ runID: first.run.id, ownerID: "owner-a", sessionID }),
      ),
    ).toBe(true)

    const recovered = await Effect.runPromise(
      ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: now,
        ownerID: "owner-b",
        leaseUntil: now + 60_000,
        now: now + 101,
      }),
    )
    expect(recovered.type).toBe("claimed")
    if (recovered.type === "claimed") {
      expect(recovered.run).toMatchObject({ id: first.run.id, status: "running", sessionID })
      expect(recovered.run.time.started).toBe(now)
    }
    expect(
      await Effect.runPromise(
        ScheduledTaskRepository.bindSession({ runID: first.run.id, ownerID: "owner-a", sessionID }),
      ),
    ).toBe(false)

    expect(
      await Effect.runPromise(
        ScheduledTaskRepository.finish({ runID: first.run.id, ownerID: "owner-a", status: "ok", now: now + 102 }),
      ),
    ).toBe(false)
    expect(
      await Effect.runPromise(
        ScheduledTaskRepository.finish({ runID: first.run.id, ownerID: "owner-b", status: "ok", now: now + 103 }),
      ),
    ).toBe(true)
  })

  test("records a missed occurrence atomically and only once", async () => {
    const task = await create(project("missed"))
    const first = await Effect.runPromise(
      ScheduledTaskRepository.markMissed({ taskID: task.id, scheduledAt: now, now: now + 10_000 }),
    )
    expect(first.type).toBe("created")
    if (first.type === "created") expect(first.run.status).toBe("missed")
    expect(
      await Effect.runPromise(
        ScheduledTaskRepository.markMissed({ taskID: task.id, scheduledAt: now, now: now + 20_000 }),
      ),
    ).toEqual({ type: "duplicate" })

    const stored = await Effect.runPromise(ScheduledTaskRepository.get(task.id))
    expect(stored?.lastStatus).toBe("missed")
    expect(await Effect.runPromise(ScheduledTaskRepository.listRuns(task.id))).toHaveLength(1)
  })

  test("disables one-time tasks and advances recurring tasks beyond now", async () => {
    const oneTime = await create(project("one-time"), { at: now })
    await Effect.runPromise(ScheduledTaskRepository.advance(oneTime, now, now + 1))
    const disabled = await Effect.runPromise(ScheduledTaskRepository.get(oneTime.id))
    expect(disabled?.enabled).toBe(false)
    expect(disabled?.nextRunAt).toBeUndefined()

    const recurring = await Effect.runPromise(
      ScheduledTaskRepository.create(
        {
          projectID: project("recurring"),
          directory: "/tmp/recurring",
          name: "Recurring",
          prompt: "Run",
          schedule: { kind: "every", interval: 1_000 },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          unattended: true,
        },
        now,
      ),
    )
    await Effect.runPromise(ScheduledTaskRepository.advance(recurring, now + 1_000, now + 3_500))
    const advanced = await Effect.runPromise(ScheduledTaskRepository.get(recurring.id))
    expect(advanced?.nextRunAt).toBe(now + 4_000)
  })

  test("exposes recoverable runs only after their lease expires", async () => {
    const task = await create(project("recoverable"))
    await Effect.runPromise(
      ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: now,
        ownerID: "owner",
        leaseUntil: now + 100,
        now,
      }),
    )
    expect(await Effect.runPromise(ScheduledTaskRepository.recoverable(now + 99))).toEqual([])
    expect((await Effect.runPromise(ScheduledTaskRepository.recoverable(now + 101)))[0]?.taskID).toBe(task.id)

    const row = Database.use((db) =>
      db.select().from(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.task_id, task.id)).get(),
    )
    expect(row?.owner_id).toBe("owner")
  })

  test("renews leases while a busy existing-session run is retrying", async () => {
    const task = await create(project("retrying"))
    const claim = await Effect.runPromise(
      ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: now,
        ownerID: "owner",
        leaseUntil: now + 100,
        now,
      }),
    )
    if (claim.type !== "claimed") throw new Error("expected initial claim")

    expect(
      await Effect.runPromise(
        ScheduledTaskRepository.retry({
          runID: claim.run.id,
          ownerID: "owner",
          attempt: 1,
          leaseUntil: now + 200,
        }),
      ),
    ).toBe(true)
    expect(
      await Effect.runPromise(
        ScheduledTaskRepository.renew({
          runID: claim.run.id,
          ownerID: "owner",
          leaseUntil: now + 30_000,
        }),
      ),
    ).toBe(true)
    expect(await Effect.runPromise(ScheduledTaskRepository.recoverable(now + 10_000))).toEqual([])
  })
})
