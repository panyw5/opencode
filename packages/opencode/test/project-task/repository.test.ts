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
      db.select({ mounted: SessionTable.mounted_task_id }).from(SessionTable).where(eq(SessionTable.id, sessionA)).get(),
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
      expect(detail?.sessionCount).toBe(3)
      const updated = yield* ProjectTaskRepository.update(task.id, { title: "Updated task" }, 2000)
      expect(updated?.time.updated).toBe(2000)
      expect(updated?.lastSessionAt).toBe(800)

      Database.use((db) => db.update(SessionTable).set({ time_updated: 1200 }).where(eq(SessionTable.id, parent)).run())
      expect((yield* ProjectTaskRepository.get(task.id))?.lastSessionAt).toBe(1200)
      Database.use((db) => db.update(SessionTable).set({ mounted_task_id: null }).where(eq(SessionTable.id, parent)).run())
      expect((yield* ProjectTaskRepository.get(task.id))?.lastSessionAt).toBe(800)
      Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, latest)).run())
      expect((yield* ProjectTaskRepository.detail(task.id))?.lastSessionAt).toBe(600)

      expect((yield* ProjectTaskRepository.archive(task.id))?.lastSessionAt).toBeUndefined()
      expect((yield* ProjectTaskRepository.getRow(task.id))?.lastSessionAt).toBeUndefined()
      expect((yield* ProjectTaskRepository.detail(task.id))?.lastSessionAt).toBeUndefined()
      expect((yield* ProjectTaskRepository.list({ projectID, includeArchived: true })).find((x) => x.id === task.id)?.lastSessionAt).toBeUndefined()
    }),
  )
})
