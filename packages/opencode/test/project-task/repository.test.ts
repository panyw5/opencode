import { afterEach, describe, expect, test } from "bun:test"
import { Database, eq } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { SessionTable, TodoTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { ProjectTaskTable } from "@/project-task/project-task.sql"
import * as ProjectTaskRepository from "@/project-task/repository"
import { ProjectTaskID } from "@/project-task/schema"
import { Effect } from "effect"

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
function seedSession(input?: { title?: string; mountedTaskID?: ProjectTaskID }) {
  sessionSeq += 1
  const id = SessionID.make(`ses_project_task_test_${sessionSeq}`)
  const now = Date.now()
  Database.use((db) => {
    db.insert(SessionTable)
      .values({
        id,
        project_id: projectID,
        slug: `s${sessionSeq}`,
        directory,
        title: input?.title ?? "Session",
        version: "test",
        mounted_task_id: input?.mountedTaskID ?? null,
        time_created: now,
        time_updated: now,
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
    expect(created.progress.total).toBe(0)

    const sessionA = seedSession({ title: "A", mountedTaskID: created.id })
    const sessionB = seedSession({ title: "B", mountedTaskID: created.id })
    seedTodos(sessionA, ["completed", "in_progress", "pending"])
    seedTodos(sessionB, ["completed", "cancelled"])

    const listed = await Effect.runPromise(ProjectTaskRepository.list({ projectID }))
    expect(listed).toHaveLength(1)
    expect(listed[0].sessionCount).toBe(2)
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

    const sessionRow = Database.use((db) =>
      db.select({ mounted: SessionTable.mounted_task_id }).from(SessionTable).where(eq(SessionTable.id, sessionA)).get(),
    )
    expect(sessionRow?.mounted).toBeNull()

    const withoutArchived = await Effect.runPromise(ProjectTaskRepository.list({ projectID }))
    expect(withoutArchived).toHaveLength(0)

    const withArchived = await Effect.runPromise(ProjectTaskRepository.list({ projectID, includeArchived: true }))
    expect(withArchived).toHaveLength(1)
  })
})
