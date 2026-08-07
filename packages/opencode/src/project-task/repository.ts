import { Database, and, asc, desc, eq, inArray, isNotNull, isNull } from "@/storage/db"
import { ProjectID } from "@/project/schema"
import { SessionTable, TodoTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import type { Todo } from "@/session/todo"
import { Effect } from "effect"
import { ProjectTaskTable } from "./project-task.sql"
import { descriptionRelativePath } from "./description-file"
import {
  CreateInput,
  Detail,
  Info,
  Progress,
  ProjectTaskID,
  SessionTodoBundle,
  Status,
  UpdateInput,
} from "./schema"

type TaskRow = typeof ProjectTaskTable.$inferSelect

const emptyProgress = (): Progress => ({
  total: 0,
  completed: 0,
  inProgress: 0,
  pending: 0,
  cancelled: 0,
})

let descriptionPathColumnReady = false

/** Older DBs may lack description_path; add it once per process. */
export function ensureDescriptionPathColumn(): void {
  if (descriptionPathColumnReady) return
  Database.use((db) => {
    const columns = db.all("PRAGMA table_info(project_task)") as Array<{ name: string }>
    if (!columns.some((column) => column.name === "description_path")) {
      db.run("ALTER TABLE project_task ADD COLUMN description_path text")
    }
  })
  descriptionPathColumnReady = true
}

export function accumulateTodo(progress: Progress, status: string): void {
  progress.total += 1
  if (status === "completed") progress.completed += 1
  else if (status === "in_progress") progress.inProgress += 1
  else if (status === "cancelled") progress.cancelled += 1
  else progress.pending += 1
}

/** Row → Info shell. `description` is filled later from the file (or legacy column during migrate). */
function taskBaseFromRow(row: TaskRow, descriptionContent: string): Omit<Info, "sessionCount" | "progress"> {
  const descriptionPath =
    (typeof row.description_path === "string" && row.description_path.trim()) || descriptionRelativePath(row.id)
  return {
    id: row.id,
    projectID: row.project_id,
    title: row.title,
    description: descriptionContent,
    descriptionPath,
    status: row.status,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_archived != null ? { archived: row.time_archived } : {}),
    },
  }
}

export type TaskRowMeta = {
  id: ProjectTaskID
  projectID: ProjectID
  title: string
  status: Status
  /** Relative path stored in DB (may be empty before migrate). */
  descriptionPath: string | null
  /** Legacy inline body (may be non-empty before migrate). */
  legacyDescription: string
  time: Info["time"]
  sessionCount: number
  progress: Progress
}

function rowMeta(row: TaskRow, sessionCount: number, progress: Progress): TaskRowMeta {
  return {
    id: row.id,
    projectID: row.project_id,
    title: row.title,
    status: row.status,
    descriptionPath: row.description_path?.trim() ? row.description_path : null,
    legacyDescription: row.description ?? "",
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_archived != null ? { archived: row.time_archived } : {}),
    },
    sessionCount,
    progress,
  }
}

export function toInfo(meta: TaskRowMeta, descriptionContent: string): Info {
  const descriptionPath = meta.descriptionPath?.trim() || descriptionRelativePath(meta.id)
  return {
    id: meta.id,
    projectID: meta.projectID,
    title: meta.title,
    description: descriptionContent,
    descriptionPath,
    status: meta.status,
    sessionCount: meta.sessionCount,
    progress: meta.progress,
    time: meta.time,
  }
}

export function create(projectID: ProjectID, input: CreateInput, now = Date.now()): Effect.Effect<Info> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    const id = ProjectTaskID.ascending()
    const status = (input.status ?? "open") as Status
    const descriptionPath = descriptionRelativePath(id)
    const row: typeof ProjectTaskTable.$inferInsert = {
      id,
      project_id: projectID,
      title: input.title.trim(),
      // Body lives in the file; DB keeps path only for new rows.
      description: "",
      description_path: descriptionPath,
      status,
      time_created: now,
      time_updated: now,
      time_archived: status === "archived" ? now : null,
    }
    Database.use((db) => db.insert(ProjectTaskTable).values(row).run())
    return {
      ...taskBaseFromRow(row as TaskRow, input.description?.trim() ?? ""),
      sessionCount: 0,
      progress: emptyProgress(),
    }
  })
}

export function getRow(id: ProjectTaskID): Effect.Effect<TaskRowMeta | undefined> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    const row = Database.use((db) => db.select().from(ProjectTaskTable).where(eq(ProjectTaskTable.id, id)).get())
    if (!row) return undefined
    const aggregates = aggregatesForTasks([id])
    const agg = aggregates.get(id) ?? { sessionCount: 0, progress: emptyProgress() }
    return rowMeta(row, agg.sessionCount, agg.progress)
  })
}

export function get(id: ProjectTaskID): Effect.Effect<Info | undefined> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    const row = Database.use((db) => db.select().from(ProjectTaskTable).where(eq(ProjectTaskTable.id, id)).get())
    if (!row) return undefined
    const aggregates = aggregatesForTasks([id])
    const agg = aggregates.get(id) ?? { sessionCount: 0, progress: emptyProgress() }
    // Prefer legacy body only until service migrates; callers that need file should use getRow + hydrate.
    return {
      ...taskBaseFromRow(row, row.description ?? ""),
      sessionCount: agg.sessionCount,
      progress: agg.progress,
    }
  })
}

export function listRows(input: {
  projectID: ProjectID
  includeArchived?: boolean
}): Effect.Effect<TaskRowMeta[]> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    const conditions = [eq(ProjectTaskTable.project_id, input.projectID)]
    if (!input.includeArchived) conditions.push(isNull(ProjectTaskTable.time_archived))
    const rows = Database.use((db) =>
      db
        .select()
        .from(ProjectTaskTable)
        .where(and(...conditions))
        .orderBy(desc(ProjectTaskTable.time_updated))
        .all(),
    )
    if (rows.length === 0) return []
    const aggregates = aggregatesForTasks(rows.map((row) => row.id))
    return rows.map((row) => {
      const agg = aggregates.get(row.id) ?? { sessionCount: 0, progress: emptyProgress() }
      return rowMeta(row, agg.sessionCount, agg.progress)
    })
  })
}

export function list(input: {
  projectID: ProjectID
  includeArchived?: boolean
}): Effect.Effect<Info[]> {
  return Effect.gen(function* () {
    const rows = yield* listRows(input)
    return rows.map((meta) => toInfo(meta, meta.legacyDescription))
  })
}

export function update(
  id: ProjectTaskID,
  input: UpdateInput & { descriptionPath?: string; clearLegacyDescription?: boolean },
  now = Date.now(),
): Effect.Effect<Info | undefined> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    return Database.transaction((db) => {
      const current = db.select().from(ProjectTaskTable).where(eq(ProjectTaskTable.id, id)).get()
      if (!current) return undefined

      const values: Partial<typeof ProjectTaskTable.$inferInsert> = {
        time_updated: now,
      }
      if (input.title !== undefined) values.title = input.title.trim()
      // Description body is file-backed; only path / legacy clear go to DB.
      if (input.descriptionPath !== undefined) values.description_path = input.descriptionPath
      if (input.clearLegacyDescription) values.description = ""
      if (input.status !== undefined) {
        values.status = input.status
        if (input.status === "archived") {
          values.time_archived = current.time_archived ?? now
        } else if (current.status === "archived") {
          values.time_archived = null
        }
      }

      db.update(ProjectTaskTable).set(values).where(eq(ProjectTaskTable.id, id)).run()
      const row = db.select().from(ProjectTaskTable).where(eq(ProjectTaskTable.id, id)).get()
      if (!row) return undefined
      const aggregates = aggregatesForTasks([id])
      const agg = aggregates.get(id) ?? { sessionCount: 0, progress: emptyProgress() }
      return {
        ...taskBaseFromRow(row, input.description ?? row.description ?? ""),
        sessionCount: agg.sessionCount,
        progress: agg.progress,
      }
    })
  })
}

/** Persist path after migrate and optionally clear legacy inline description. */
export function setDescriptionPath(
  id: ProjectTaskID,
  descriptionPath: string,
  opts?: { clearLegacy?: boolean },
  now = Date.now(),
): Effect.Effect<void> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    const values: Partial<typeof ProjectTaskTable.$inferInsert> = {
      description_path: descriptionPath,
      time_updated: now,
    }
    if (opts?.clearLegacy) values.description = ""
    Database.use((db) => db.update(ProjectTaskTable).set(values).where(eq(ProjectTaskTable.id, id)).run())
  })
}

/** Soft-archive: set status archived and clear session mounts. */
export function archive(id: ProjectTaskID, now = Date.now()): Effect.Effect<Info | undefined> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    return Database.transaction((db) => {
      const current = db.select().from(ProjectTaskTable).where(eq(ProjectTaskTable.id, id)).get()
      if (!current) return undefined
      db.update(SessionTable)
        .set({ mounted_task_id: null, time_updated: now })
        .where(eq(SessionTable.mounted_task_id, id))
        .run()
      db.update(ProjectTaskTable)
        .set({
          status: "archived",
          time_archived: current.time_archived ?? now,
          time_updated: now,
        })
        .where(eq(ProjectTaskTable.id, id))
        .run()
      const row = db.select().from(ProjectTaskTable).where(eq(ProjectTaskTable.id, id)).get()
      if (!row) return undefined
      return {
        ...taskBaseFromRow(row, row.description ?? ""),
        sessionCount: 0,
        progress: emptyProgress(),
      }
    })
  })
}

export function detailRow(id: ProjectTaskID): Effect.Effect<(TaskRowMeta & { sessions: SessionTodoBundle[] }) | undefined> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    const row = Database.use((db) => db.select().from(ProjectTaskTable).where(eq(ProjectTaskTable.id, id)).get())
    if (!row) return undefined

    const sessions = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.mounted_task_id, id))
        .orderBy(desc(SessionTable.time_updated))
        .all(),
    )

    const sessionIDs = sessions.map((session) => session.id)
    const todoRows =
      sessionIDs.length === 0
        ? []
        : Database.use((db) =>
            db
              .select()
              .from(TodoTable)
              .where(inArray(TodoTable.session_id, sessionIDs))
              .orderBy(asc(TodoTable.session_id), asc(TodoTable.position))
              .all(),
          )

    const todosBySession = new Map<SessionID, Todo.Info[]>()
    for (const todo of todoRows) {
      const list = todosBySession.get(todo.session_id) ?? []
      list.push({
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
      })
      todosBySession.set(todo.session_id, list)
    }

    const bundles: SessionTodoBundle[] = sessions.map((session) => {
      const todos = todosBySession.get(session.id) ?? []
      const progress = emptyProgress()
      for (const todo of todos) accumulateTodo(progress, todo.status)
      return {
        sessionID: session.id,
        title: session.title,
        directory: session.directory,
        ...(session.parent_id ? { parentID: session.parent_id } : {}),
        time: {
          created: session.time_created,
          updated: session.time_updated,
          ...(session.time_archived != null ? { archived: session.time_archived } : {}),
        },
        progress,
        todos,
      }
    })

    const progress = emptyProgress()
    for (const bundle of bundles) {
      progress.total += bundle.progress.total
      progress.completed += bundle.progress.completed
      progress.inProgress += bundle.progress.inProgress
      progress.pending += bundle.progress.pending
      progress.cancelled += bundle.progress.cancelled
    }

    return {
      ...rowMeta(row, bundles.length, progress),
      sessions: bundles,
    }
  })
}

export function detail(id: ProjectTaskID): Effect.Effect<Detail | undefined> {
  return Effect.gen(function* () {
    const row = yield* detailRow(id)
    if (!row) return undefined
    const info = toInfo(row, row.legacyDescription)
    return { ...info, sessions: row.sessions }
  })
}

function aggregatesForTasks(taskIDs: ProjectTaskID[]): Map<ProjectTaskID, { sessionCount: number; progress: Progress }> {
  const result = new Map<ProjectTaskID, { sessionCount: number; progress: Progress }>()
  for (const id of taskIDs) {
    result.set(id, { sessionCount: 0, progress: emptyProgress() })
  }
  if (taskIDs.length === 0) return result

  const sessions = Database.use((db) =>
    db
      .select({
        id: SessionTable.id,
        mounted_task_id: SessionTable.mounted_task_id,
      })
      .from(SessionTable)
      .where(and(inArray(SessionTable.mounted_task_id, taskIDs), isNotNull(SessionTable.mounted_task_id)))
      .all(),
  )

  const sessionToTask = new Map<SessionID, ProjectTaskID>()
  for (const session of sessions) {
    if (!session.mounted_task_id) continue
    sessionToTask.set(session.id, session.mounted_task_id)
    const entry = result.get(session.mounted_task_id)
    if (entry) entry.sessionCount += 1
  }

  const sessionIDs = [...sessionToTask.keys()]
  if (sessionIDs.length === 0) return result

  const todos = Database.use((db) =>
    db
      .select({
        session_id: TodoTable.session_id,
        status: TodoTable.status,
      })
      .from(TodoTable)
      .where(inArray(TodoTable.session_id, sessionIDs))
      .all(),
  )

  for (const todo of todos) {
    const taskID = sessionToTask.get(todo.session_id)
    if (!taskID) continue
    const entry = result.get(taskID)
    if (!entry) continue
    accumulateTodo(entry.progress, todo.status)
  }

  return result
}

export function existsInProject(id: ProjectTaskID, projectID: ProjectID): Effect.Effect<boolean> {
  return Effect.sync(() => {
    ensureDescriptionPathColumn()
    const row = Database.use((db) =>
      db
        .select({ id: ProjectTaskTable.id })
        .from(ProjectTaskTable)
        .where(and(eq(ProjectTaskTable.id, id), eq(ProjectTaskTable.project_id, projectID)))
        .get(),
    )
    return !!row
  })
}

export * as ProjectTaskRepository from "./repository"
