import { Database, and, asc, desc, eq, gt, inArray, isNull, lt, or } from "@/storage/db"
import { Effect, Schema } from "effect"
import { ProjectID } from "@/project/schema"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "./scheduled-task.sql"
import {
  CreateInput,
  ExecutionMode,
  Info,
  Model,
  Run,
  Schedule,
  ScheduledTaskID,
  ScheduledTaskRunID,
  Status,
  UpdateInput,
} from "./schema"
import { ScheduledTaskSchedule } from "./schedule"

type TaskRow = typeof ScheduledTaskTable.$inferSelect
type RunRow = typeof ScheduledTaskRunTable.$inferSelect

export type ClaimResult = { type: "claimed"; run: Run } | { type: "duplicate" } | { type: "overlap"; run: Run }

export type MissResult = { type: "created"; run: Run } | { type: "duplicate" }

export function create(input: CreateInput, now = Date.now()): Effect.Effect<Info> {
  return Effect.sync(() => {
    ScheduledTaskSchedule.validate(input.schedule)
    const id = ScheduledTaskID.ascending()
    const nextRunAt = input.enabled === false ? undefined : ScheduledTaskSchedule.next(input.schedule, now)
    const row: typeof ScheduledTaskTable.$inferInsert = {
      id,
      project_id: input.projectID,
      project_name: input.projectName,
      directory: input.directory,
      name: input.name,
      prompt: input.prompt,
      ...scheduleToRow(input.schedule),
      execution_mode: input.executionMode ?? "existing_session",
      session_id: input.sessionID,
      agent: input.agent,
      model: input.model,
      enabled: input.enabled ?? true,
      unattended: true,
      next_run_at: nextRunAt,
      time_created: now,
      time_updated: now,
    }
    Database.use((db) => db.insert(ScheduledTaskTable).values(row).run())
    return taskFromRow({ ...row, last_run_at: null, last_status: null, last_error: null } as TaskRow)
  })
}

export function get(id: ScheduledTaskID): Effect.Effect<Info | undefined> {
  return Effect.sync(() => {
    const row = Database.use((db) => db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get())
    return row ? taskFromRow(row) : undefined
  })
}

export function list(input?: { projectID?: string; enabled?: boolean }): Effect.Effect<Info[]> {
  return Effect.sync(() => {
    const conditions: ReturnType<typeof eq>[] = []
    if (input?.projectID) conditions.push(eq(ScheduledTaskTable.project_id, ProjectID.make(input.projectID)))
    if (input?.enabled !== undefined) conditions.push(eq(ScheduledTaskTable.enabled, input.enabled))
    const rows = Database.use((db) => {
      const query = db.select().from(ScheduledTaskTable).orderBy(asc(ScheduledTaskTable.time_created))
      return conditions.length ? query.where(and(...conditions)).all() : query.all()
    })
    return rows.map(taskFromRow)
  })
}

export function update(id: ScheduledTaskID, input: UpdateInput, now = Date.now()): Effect.Effect<Info | undefined> {
  return Effect.sync(() => {
    return Database.transaction((db) => {
      const current = db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get()
      if (!current) return undefined
      const schedule = input.schedule ?? scheduleFromRow(current)
      ScheduledTaskSchedule.validate(schedule)
      const enabled = input.enabled ?? current.enabled
      const reschedule = input.schedule !== undefined || input.enabled !== undefined
      const values: Partial<typeof ScheduledTaskTable.$inferInsert> = {
        name: input.name,
        prompt: input.prompt,
        execution_mode: input.executionMode,
        session_id: input.sessionID,
        agent: input.agent,
        model: input.model,
        enabled: input.enabled,
        time_updated: now,
      }
      if (input.schedule) Object.assign(values, scheduleToRow(input.schedule))
      if (reschedule) values.next_run_at = enabled ? ScheduledTaskSchedule.next(schedule, now) : null
      const clean = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
      db.update(ScheduledTaskTable).set(clean).where(eq(ScheduledTaskTable.id, id)).run()
      const row = db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get()
      return row ? taskFromRow(row) : undefined
    })
  })
}

export function remove(id: ScheduledTaskID): Effect.Effect<boolean> {
  return Effect.sync(() =>
    Database.transaction((db) => {
      const exists = db
        .select({ id: ScheduledTaskTable.id })
        .from(ScheduledTaskTable)
        .where(eq(ScheduledTaskTable.id, id))
        .get()
      if (!exists) return false
      db.delete(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).run()
      return true
    }),
  )
}

export function listRuns(id: ScheduledTaskID, limit = 100): Effect.Effect<Run[]> {
  return Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(ScheduledTaskRunTable)
        .where(eq(ScheduledTaskRunTable.task_id, id))
        .orderBy(desc(ScheduledTaskRunTable.scheduled_at))
        .limit(limit)
        .all(),
    ).map(runFromRow),
  )
}

export function due(now = Date.now()): Effect.Effect<Info[]> {
  return Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(ScheduledTaskTable)
        .where(
          and(
            eq(ScheduledTaskTable.enabled, true),
            or(eq(ScheduledTaskTable.next_run_at, now), lt(ScheduledTaskTable.next_run_at, now)),
          ),
        )
        .orderBy(asc(ScheduledTaskTable.next_run_at))
        .all(),
    ).map(taskFromRow),
  )
}

export function claim(input: {
  taskID: ScheduledTaskID
  scheduledAt: number
  ownerID: string
  leaseUntil: number
  now?: number
}): Effect.Effect<ClaimResult> {
  return Effect.sync(() => {
    const now = input.now ?? Date.now()
    return Database.transaction(
      (db) => {
        const existing = db
          .select()
          .from(ScheduledTaskRunTable)
          .where(
            and(
              eq(ScheduledTaskRunTable.task_id, input.taskID),
              eq(ScheduledTaskRunTable.scheduled_at, input.scheduledAt),
            ),
          )
          .get()
        if (existing) {
          if (
            (existing.status === "running" || existing.status === "retrying") &&
            existing.lease_until !== null &&
            existing.lease_until <= now
          ) {
            db.update(ScheduledTaskRunTable)
              .set({
                status: "running",
                owner_id: input.ownerID,
                lease_until: input.leaseUntil,
                time_started: existing.time_started ?? now,
                time_finished: null,
                error: null,
              })
              .where(eq(ScheduledTaskRunTable.id, existing.id))
              .run()
            const recovered = db
              .select()
              .from(ScheduledTaskRunTable)
              .where(eq(ScheduledTaskRunTable.id, existing.id))
              .get()
            if (!recovered) return { type: "duplicate" } satisfies ClaimResult
            return { type: "claimed", run: runFromRow(recovered) } satisfies ClaimResult
          }
          return { type: "duplicate" } satisfies ClaimResult
        }

        const active = db
          .select({ id: ScheduledTaskRunTable.id })
          .from(ScheduledTaskRunTable)
          .where(
            and(
              eq(ScheduledTaskRunTable.task_id, input.taskID),
              inArray(ScheduledTaskRunTable.status, ["running", "retrying"]),
              or(isNull(ScheduledTaskRunTable.lease_until), gt(ScheduledTaskRunTable.lease_until, now)),
            ),
          )
          .get()
        const id = ScheduledTaskRunID.ascending()
        const status: Status = active ? "skipped" : "running"
        const row: typeof ScheduledTaskRunTable.$inferInsert = {
          id,
          task_id: input.taskID,
          scheduled_at: input.scheduledAt,
          status,
          owner_id: active ? null : input.ownerID,
          lease_until: active ? null : input.leaseUntil,
          attempt: 0,
          time_created: now,
          time_started: active ? null : now,
          time_finished: active ? now : null,
        }
        db.insert(ScheduledTaskRunTable).values(row).run()
        const run = runFromRow({ ...row, session_id: null, error: null } as RunRow)
        return active
          ? ({ type: "overlap", run } satisfies ClaimResult)
          : ({ type: "claimed", run } satisfies ClaimResult)
      },
      { behavior: "immediate" },
    )
  })
}

export function renew(input: {
  runID: ScheduledTaskRunID
  ownerID: string
  leaseUntil: number
}): Effect.Effect<boolean> {
  return Effect.sync(() =>
    Database.transaction((db) => {
      const owned = db
        .select({ id: ScheduledTaskRunTable.id })
        .from(ScheduledTaskRunTable)
      .where(
        and(
          eq(ScheduledTaskRunTable.id, input.runID),
          eq(ScheduledTaskRunTable.owner_id, input.ownerID),
          inArray(ScheduledTaskRunTable.status, ["running", "retrying"]),
        ),
      )
        .get()
      if (!owned) return false
      db.update(ScheduledTaskRunTable)
        .set({ lease_until: input.leaseUntil })
        .where(
          and(
            eq(ScheduledTaskRunTable.id, input.runID),
            eq(ScheduledTaskRunTable.owner_id, input.ownerID),
            inArray(ScheduledTaskRunTable.status, ["running", "retrying"]),
          ),
        )
        .run()
      return true
    }),
  )
}

export function retry(input: {
  runID: ScheduledTaskRunID
  ownerID: string
  attempt: number
  leaseUntil: number
}): Effect.Effect<boolean> {
  return Effect.sync(() =>
    Database.transaction((db) => {
      const owned = db
        .select({ id: ScheduledTaskRunTable.id })
        .from(ScheduledTaskRunTable)
        .where(and(eq(ScheduledTaskRunTable.id, input.runID), eq(ScheduledTaskRunTable.owner_id, input.ownerID)))
        .get()
      if (!owned) return false
      db.update(ScheduledTaskRunTable)
        .set({ status: "retrying", attempt: input.attempt, lease_until: input.leaseUntil })
        .where(eq(ScheduledTaskRunTable.id, input.runID))
        .run()
      return true
    }),
  )
}

export function resume(input: {
  runID: ScheduledTaskRunID
  ownerID: string
  leaseUntil: number
}): Effect.Effect<boolean> {
  return Effect.sync(() =>
    Database.transaction((db) => {
      const owned = db
        .select({ id: ScheduledTaskRunTable.id })
        .from(ScheduledTaskRunTable)
        .where(and(eq(ScheduledTaskRunTable.id, input.runID), eq(ScheduledTaskRunTable.owner_id, input.ownerID)))
        .get()
      if (!owned) return false
      db.update(ScheduledTaskRunTable)
        .set({ status: "running", lease_until: input.leaseUntil })
        .where(eq(ScheduledTaskRunTable.id, input.runID))
        .run()
      return true
    }),
  )
}

export function finish(input: {
  runID: ScheduledTaskRunID
  ownerID: string
  status: "ok" | "error" | "skipped" | "missed"
  sessionID?: Schema.Schema.Type<typeof Run>["sessionID"]
  error?: string
  now?: number
}): Effect.Effect<boolean> {
  return Effect.sync(() => {
    const now = input.now ?? Date.now()
    return Database.transaction((db) => {
      const owned = db
        .select({ id: ScheduledTaskRunTable.id })
        .from(ScheduledTaskRunTable)
        .where(and(eq(ScheduledTaskRunTable.id, input.runID), eq(ScheduledTaskRunTable.owner_id, input.ownerID)))
        .get()
      if (!owned) return false
      db.update(ScheduledTaskRunTable)
        .set({
          status: input.status,
          owner_id: null,
          lease_until: null,
          session_id: input.sessionID,
          error: input.error,
          time_finished: now,
        })
        .where(and(eq(ScheduledTaskRunTable.id, input.runID), eq(ScheduledTaskRunTable.owner_id, input.ownerID)))
        .run()
      const run = db.select().from(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.id, input.runID)).get()
      if (!run) return false
      db.update(ScheduledTaskTable)
        .set({
          last_run_at: now,
          last_status: input.status,
          last_error: input.error ?? null,
          time_updated: now,
        })
        .where(eq(ScheduledTaskTable.id, run.task_id))
        .run()
      return true
    })
  })
}

export function markMissed(input: {
  taskID: ScheduledTaskID
  scheduledAt: number
  error?: string
  now?: number
}): Effect.Effect<MissResult> {
  return Effect.sync(() => {
    const now = input.now ?? Date.now()
    return Database.transaction(
      (db) => {
        const existing = db
          .select()
          .from(ScheduledTaskRunTable)
          .where(
            and(
              eq(ScheduledTaskRunTable.task_id, input.taskID),
              eq(ScheduledTaskRunTable.scheduled_at, input.scheduledAt),
            ),
          )
          .get()
        if (existing) return { type: "duplicate" } satisfies MissResult

        const row: typeof ScheduledTaskRunTable.$inferInsert = {
          id: ScheduledTaskRunID.ascending(),
          task_id: input.taskID,
          scheduled_at: input.scheduledAt,
          status: "missed",
          owner_id: null,
          lease_until: null,
          attempt: 0,
          session_id: null,
          error: input.error,
          time_created: now,
          time_started: null,
          time_finished: now,
        }
        db.insert(ScheduledTaskRunTable).values(row).run()
        db.update(ScheduledTaskTable)
          .set({
            last_run_at: now,
            last_status: "missed",
            last_error: input.error ?? null,
            time_updated: now,
          })
          .where(eq(ScheduledTaskTable.id, input.taskID))
          .run()
        return { type: "created", run: runFromRow(row as RunRow) } satisfies MissResult
      },
      { behavior: "immediate" },
    )
  })
}

export function setNextRun(id: ScheduledTaskID, nextRunAt: number | undefined, now = Date.now()): Effect.Effect<void> {
  return Effect.sync(() => {
    Database.use((db) =>
      db
        .update(ScheduledTaskTable)
        .set({ next_run_at: nextRunAt ?? null, time_updated: now })
        .where(eq(ScheduledTaskTable.id, id))
        .run(),
    )
  })
}

export function advance(task: Info, scheduledAt: number, now = Date.now()): Effect.Effect<void> {
  return Effect.sync(() => {
    const nextRunAt = ScheduledTaskSchedule.nextAfterOccurrence(task.schedule, scheduledAt, now)
    Database.use((db) =>
      db
        .update(ScheduledTaskTable)
        .set({
          enabled: task.schedule.kind === "at" ? false : task.enabled,
          next_run_at: nextRunAt ?? null,
          time_updated: now,
        })
        .where(eq(ScheduledTaskTable.id, task.id))
        .run(),
    )
  })
}

export function recordStatus(input: {
  taskID: ScheduledTaskID
  status: "skipped" | "missed"
  error?: string
  now?: number
}): Effect.Effect<void> {
  return Effect.sync(() => {
    const now = input.now ?? Date.now()
    Database.use((db) =>
      db
        .update(ScheduledTaskTable)
        .set({
          last_run_at: now,
          last_status: input.status,
          last_error: input.error ?? null,
          time_updated: now,
        })
        .where(eq(ScheduledTaskTable.id, input.taskID))
        .run(),
    )
  })
}

export function recoverable(now = Date.now()): Effect.Effect<Run[]> {
  return Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(ScheduledTaskRunTable)
        .where(
          and(
            inArray(ScheduledTaskRunTable.status, ["running", "retrying"]),
            or(isNull(ScheduledTaskRunTable.lease_until), lt(ScheduledTaskRunTable.lease_until, now)),
          ),
        )
        .all(),
    ).map(runFromRow),
  )
}

function taskFromRow(row: TaskRow): Info {
  return {
    id: row.id,
    projectID: row.project_id,
    projectName: row.project_name ?? undefined,
    directory: row.directory,
    name: row.name,
    prompt: row.prompt,
    schedule: scheduleFromRow(row),
    executionMode: Schema.decodeUnknownSync(ExecutionMode)(row.execution_mode),
    sessionID: row.session_id ?? undefined,
    agent: row.agent,
    model: Schema.decodeUnknownSync(Model)(row.model),
    enabled: row.enabled,
    unattended: true,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: row.last_status ? Schema.decodeUnknownSync(Status)(row.last_status) : undefined,
    lastError: row.last_error ?? undefined,
    time: { created: row.time_created, updated: row.time_updated },
  }
}

function runFromRow(row: RunRow): Run {
  return {
    id: row.id,
    taskID: row.task_id,
    scheduledAt: row.scheduled_at,
    status: Schema.decodeUnknownSync(Status)(row.status),
    attempt: row.attempt,
    sessionID: row.session_id ?? undefined,
    error: row.error ?? undefined,
    time: {
      created: row.time_created,
      started: row.time_started ?? undefined,
      finished: row.time_finished ?? undefined,
    },
  }
}

function scheduleToRow(schedule: Schedule) {
  if (schedule.kind === "at") {
    return { schedule_kind: schedule.kind, schedule_value: String(schedule.at), schedule_timezone: null }
  }
  if (schedule.kind === "every") {
    return { schedule_kind: schedule.kind, schedule_value: String(schedule.interval), schedule_timezone: null }
  }
  return {
    schedule_kind: schedule.kind,
    schedule_value: schedule.expression,
    schedule_timezone: schedule.timezone ?? null,
  }
}

function scheduleFromRow(row: Pick<TaskRow, "schedule_kind" | "schedule_value" | "schedule_timezone">): Schedule {
  if (row.schedule_kind === "at") return { kind: "at", at: Number(row.schedule_value) }
  if (row.schedule_kind === "every") return { kind: "every", interval: Number(row.schedule_value) }
  return {
    kind: "cron",
    expression: row.schedule_value,
    timezone: row.schedule_timezone ?? undefined,
  }
}

export * as ScheduledTaskRepository from "./repository"
