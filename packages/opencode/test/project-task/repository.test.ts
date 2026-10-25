import { afterEach, describe, expect, test } from "bun:test"
import { Database, eq } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { SessionTable, TodoTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { ProjectTaskTable } from "@/project-task/project-task.sql"
import * as ProjectTaskRepository from "@/project-task/repository"
import { ProjectTaskID } from "@/project-task/schema"
import { Effect, Layer, Schema } from "effect"
import { Info } from "@/project-task/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

const projectID = ProjectID.make("proj_test_project_task")
const directory = "/tmp/project-task-test"

function seedProject() {
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: projectID,
        worktree: directory,
        vcs: "git",
        sandboxes: [],
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .onConflictDoNothing()
      .run()
  })
}

function cleanup() {
  Database.use((db) => {
    db.delete(TodoTable).run()
    db.delete(SessionTable).where(eq(SessionTable.project_id, projectID)).run()
    db.delete(ProjectTaskTable).where(eq(ProjectTaskTable.project_id, projectID)).run()
  })
}

let sessionSeq = 0
function seedSession(input?: {
  title?: string
  mountedTaskID?: ProjectTaskID
  directory?: string
  updated?: number
  archived?: number
  parentID?: SessionID
}) {
  sessionSeq += 1
  const id = SessionID.make(`ses_project_task_test_${sessionSeq}`)
  const now = Date.now()
  Database.use((db) => {
    db.insert(SessionTable)
      .values({
        id,
        project_id: projectID,
        slug: `s${sessionSeq}`,
        directory: input?.directory ?? directory,
        title: input?.title ?? "Session",
        version: "test",
        mounted_task_id: input?.mountedTaskID ?? null,
        time_created: now,
        time_updated: input?.updated ?? now,
        time_archived: input?.archived ?? null,
        parent_id: input?.parentID ?? null,
      })
      .run()
  })
  return id
}

function seedTodos(sessionID: SessionID, statuses: string[]) {
  Database.use((db) => {
    if (statuses.length === 0) return
    db.insert(TodoTable)
      .values(
        statuses.map((status, position) => ({
          session_id: sessionID,
          content: `todo ${position}`,
          status,
          priority: "medium",
          position,
          time_created: Date.now(),
          time_updated: Date.now(),
        })),
      )
      .run()
  })
}

describe("ProjectTaskRepository", () => {
  afterEach(() => {
    cleanup()
  })

  it.live("recent tasks mix creation and linked session activity, not task edits", () =>
    Effect.gen(function* () {
      seedProject()
      const active = yield* ProjectTaskRepository.create(projectID, { title: "Old active" }, 100)
      const newest = yield* ProjectTaskRepository.create(projectID, { title: "New unmounted" }, 900)
      const edited = yield* ProjectTaskRepository.create(projectID, { title: "Edited only" }, 200)
      const archived = yield* ProjectTaskRepository.create(projectID, { title: "Archived", status: "archived" }, 2000)
      const done = yield* ProjectTaskRepository.create(projectID, { title: "Completed", status: "done" }, 300)
      const parent = seedSession({ mountedTaskID: active.id, updated: 400 })
      seedSession({ mountedTaskID: active.id, parentID: parent, updated: 1000, archived: 1100 })
      seedSession({ mountedTaskID: newest.id, updated: 500 })
      seedSession({ mountedTaskID: archived.id, updated: 3000 })
      seedSession({ updated: 5000 })
      seedTodos(parent, ["completed", "pending"])
      yield* ProjectTaskRepository.update(edited.id, { title: "Recent edit" }, 4000)

      const tasks = yield* ProjectTaskRepository.recent(3)
      expect(tasks.map((task) => task.id)).toEqual([active.id, newest.id, done.id])
      expect(tasks.map((task) => task.recentAt)).toEqual([1000, 900, 300])
      expect(tasks[0].directory).toBe(directory)
      expect(tasks[0].sessionCount).toBe(1)
      expect(tasks[0].progress.total).toBe(2)
      expect(tasks[0].description).toBe("")
      expect((yield* ProjectTaskRepository.recent(1)).map((task) => task.id)).toEqual([active.id])

      Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.mounted_task_id, active.id)).run())
      expect((yield* ProjectTaskRepository.recent(2)).map((task) => task.id)).toEqual([newest.id, done.id])
    }),
  )

  it.live("recent tasks span projects and exclude internal projects", () =>
    Effect.gen(function* () {
      seedProject()
      const otherID = ProjectID.make("proj_recent_other")
      const hiddenID = ProjectID.make("proj_recent_internal")
      Database.use((db) =>
        db
          .insert(ProjectTable)
          .values([
            {
              id: otherID,
              worktree: "/tmp/other-project",
              name: "Other project",
              sandboxes: [],
              time_created: 0,
              time_updated: 0,
            },
            {
              id: hiddenID,
              worktree: "/tmp/internal",
              visibility: "internal",
              sandboxes: [],
              time_created: 0,
              time_updated: 0,
            },
          ])
          .run(),
      )
      yield* Effect.gen(function* () {
        const first = yield* ProjectTaskRepository.create(projectID, { title: "First" }, 100)
        const second = yield* ProjectTaskRepository.create(otherID, { title: "Second" }, 200)
        yield* ProjectTaskRepository.create(hiddenID, { title: "Hidden" }, 300)
        const tasks = yield* ProjectTaskRepository.recent()
        expect(tasks.map((task) => task.id)).toEqual([second.id, first.id])
        expect(tasks[0].directory).toBe("/tmp/other-project")
        expect(tasks[0].projectName).toBe("Other project")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() =>
            Database.use((db) => {
              db.delete(ProjectTaskTable).where(eq(ProjectTaskTable.project_id, otherID)).run()
              db.delete(ProjectTaskTable).where(eq(ProjectTaskTable.project_id, hiddenID)).run()
              db.delete(ProjectTable).where(eq(ProjectTable.id, otherID)).run()
              db.delete(ProjectTable).where(eq(ProjectTable.id, hiddenID)).run()
            }),
          ),
        ),
      )
    }),
  )

  test("create list update archive with progress aggregation", async () => {
    seedProject()

    const created = await Effect.runPromise(
      ProjectTaskRepository.create(projectID, {
        title: "Ship project task manager",
        description: "Link sessions and todos",
        status: "open",
      }),
    )
    expect(created.title).toBe("Ship project task manager")
    expect(created.descriptionPath.includes(created.id)).toBe(true)
    expect(created.descriptionPath.endsWith("prd.md")).toBe(true)
    expect(created.sessionCount).toBe(0)
    expect(created.lastSessionAt).toBeUndefined()
    expect(created.progress.total).toBe(0)

    const sessionA = seedSession({ title: "A", mountedTaskID: created.id })
    const sessionB = seedSession({ title: "B", mountedTaskID: created.id })
    seedTodos(sessionA, ["completed", "in_progress", "pending"])
    seedTodos(sessionB, ["completed", "cancelled"])

    const listed = await Effect.runPromise(ProjectTaskRepository.list({ projectID }))
    expect(listed).toHaveLength(1)
    expect(listed[0].sessionCount).toBe(2)
    expect(listed[0].sessionDirectories).toEqual([directory])
    expect(listed[0].progress).toEqual({
      total: 5,
      completed: 2,
      inProgress: 1,
      pending: 1,
      cancelled: 1,
    })

    const detail = await Effect.runPromise(ProjectTaskRepository.detail(created.id))
    expect(detail?.sessions).toHaveLength(2)
    expect(detail?.sessions.find((s) => s.sessionID === sessionA)?.todos).toHaveLength(3)

    const updated = await Effect.runPromise(
      ProjectTaskRepository.update(created.id, { status: "in_progress", title: "Ship MVP" }),
    )
    expect(updated?.status).toBe("in_progress")
    expect(updated?.title).toBe("Ship MVP")

    const archived = await Effect.runPromise(ProjectTaskRepository.archive(created.id))
    expect(archived?.status).toBe("archived")
    expect(archived?.sessionCount).toBe(0)
    expect(archived?.lastSessionAt).toBeUndefined()

    const sessionRow = Database.use((db) =>
      db
        .select({ mounted: SessionTable.mounted_task_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionA))
        .get(),
    )
    expect(sessionRow?.mounted).toBeNull()

    const withoutArchived = await Effect.runPromise(ProjectTaskRepository.list({ projectID }))
    expect(withoutArchived).toHaveLength(0)

    const withArchived = await Effect.runPromise(ProjectTaskRepository.list({ projectID, includeArchived: true }))
    expect(withArchived).toHaveLength(1)
  })

  test("lists unique session directories across worktrees", async () => {
    seedProject()
    const created = await Effect.runPromise(
      ProjectTaskRepository.create(projectID, {
        title: "Split by worktree",
        status: "open",
      }),
    )
    seedSession({ title: "main", mountedTaskID: created.id, directory })
    seedSession({ title: "sandbox", mountedTaskID: created.id, directory: `${directory}-wt` })

    const listed = await Effect.runPromise(ProjectTaskRepository.list({ projectID }))
    expect(listed).toHaveLength(1)
    expect(listed[0].sessionCount).toBe(2)
    expect(listed[0].sessionDirectories.toSorted()).toEqual([directory, `${directory}-wt`].toSorted())
  })

  it.live("counts only directly linked primary sessions without losing child associations", () =>
    Effect.gen(function* () {
      seedProject()
      const task = yield* ProjectTaskRepository.create(projectID, { title: "Primary sessions" })
      const other = yield* ProjectTaskRepository.create(projectID, { title: "Other task" })
      const parent = seedSession({ mountedTaskID: task.id })
      const child = seedSession({ mountedTaskID: task.id, parentID: parent })
      const archivedChild = seedSession({ mountedTaskID: task.id, parentID: parent, archived: Date.now() })
      seedTodos(child, ["completed"])
      seedTodos(archivedChild, ["pending"])
      const listed = yield* ProjectTaskRepository.list({ projectID })
      expect(listed.find((item) => item.id === task.id)?.sessionCount).toBe(1)
      expect((yield* ProjectTaskRepository.get(task.id))?.sessionCount).toBe(1)
      const detail = yield* ProjectTaskRepository.detail(task.id)
      expect(detail?.sessionCount).toBe(1)
      expect(detail?.sessions).toHaveLength(3)
      expect(detail?.progress.total).toBe(2)

      Database.use((db) =>
        db.update(SessionTable).set({ mounted_task_id: other.id }).where(eq(SessionTable.id, parent)).run(),
      )
      const moved = yield* ProjectTaskRepository.list({ projectID })
      expect(moved.find((item) => item.id === task.id)?.sessionCount).toBe(0)
      expect(moved.find((item) => item.id === other.id)?.sessionCount).toBe(1)
      const childOnly = yield* ProjectTaskRepository.detail(task.id)
      expect(childOnly?.sessionCount).toBe(0)
      expect(childOnly?.sessions.map((item) => item.sessionID).sort()).toEqual([child, archivedChild].sort())
      expect(childOnly?.sessions.every((item) => item.parentID === parent)).toBe(true)
      expect(childOnly?.progress.total).toBe(2)

      yield* ProjectTaskRepository.archive(task.id)
      expect((yield* ProjectTaskRepository.detail(task.id))?.sessions).toHaveLength(0)
      expect(
        Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, parent)).get())?.mounted_task_id,
      ).toBe(other.id)
    }),
  )

  it.live("preserves latest mounted session time across all repository outputs and scopes", () =>
    Effect.gen(function* () {
      seedProject()
      const task = yield* ProjectTaskRepository.create(projectID, { title: "Recent sessions" }, 100)
      const other = yield* ProjectTaskRepository.create(projectID, { title: "Other task" }, 200)
      const empty = yield* ProjectTaskRepository.create(projectID, { title: "No sessions" }, 300)
      const parent = seedSession({ mountedTaskID: task.id, updated: 400 })
      seedSession({ mountedTaskID: task.id, updated: 600, parentID: parent, directory: `${directory}-wt` })
      // Aggregation already includes archived sessions and child sessions; preserve that scope.
      const latest = seedSession({ mountedTaskID: task.id, updated: 800, archived: 700 })
      seedSession({ mountedTaskID: other.id, updated: 900 })
      seedSession({ updated: 1000 })

      const listed = yield* ProjectTaskRepository.list({ projectID })
      expect(listed.find((x) => x.id === task.id)?.lastSessionAt).toBe(800)
      expect(listed.find((x) => x.id === other.id)?.lastSessionAt).toBe(900)
      const unmounted = listed.find((x) => x.id === empty.id)
      expect(unmounted?.lastSessionAt).toBeUndefined()
      expect(unmounted && Schema.encodeSync(Info)(unmounted)).not.toHaveProperty("lastSessionAt")

      const rows = yield* ProjectTaskRepository.listRows({ projectID })
      expect(rows.find((x) => x.id === task.id)?.lastSessionAt).toBe(800)
      const row = yield* ProjectTaskRepository.getRow(task.id)
      expect(row?.lastSessionAt).toBe(800)
      expect(row && ProjectTaskRepository.toInfo(row, "").lastSessionAt).toBe(800)
      expect((yield* ProjectTaskRepository.get(task.id))?.lastSessionAt).toBe(800)
      expect((yield* ProjectTaskRepository.detailRow(task.id))?.lastSessionAt).toBe(800)
      const detail = yield* ProjectTaskRepository.detail(task.id)
      expect(detail?.lastSessionAt).toBe(800)
      expect(detail?.sessionCount).toBe(2)
      const updated = yield* ProjectTaskRepository.update(task.id, { title: "Updated task" }, 2000)
      expect(updated?.time.updated).toBe(2000)
      expect(updated?.lastSessionAt).toBe(800)

      Database.use((db) => db.update(SessionTable).set({ time_updated: 1200 }).where(eq(SessionTable.id, parent)).run())
      expect((yield* ProjectTaskRepository.get(task.id))?.lastSessionAt).toBe(1200)
      Database.use((db) =>
        db.update(SessionTable).set({ mounted_task_id: null }).where(eq(SessionTable.id, parent)).run(),
      )
      expect((yield* ProjectTaskRepository.get(task.id))?.lastSessionAt).toBe(800)
      Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, latest)).run())
      expect((yield* ProjectTaskRepository.detail(task.id))?.lastSessionAt).toBe(600)

      expect((yield* ProjectTaskRepository.archive(task.id))?.lastSessionAt).toBeUndefined()
      expect((yield* ProjectTaskRepository.getRow(task.id))?.lastSessionAt).toBeUndefined()
      expect((yield* ProjectTaskRepository.detail(task.id))?.lastSessionAt).toBeUndefined()
      expect(
        (yield* ProjectTaskRepository.list({ projectID, includeArchived: true })).find((x) => x.id === task.id)
          ?.lastSessionAt,
      ).toBeUndefined()
    }),
  )
})
