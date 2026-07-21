import { ProjectTable } from "@/project/project.sql"
import type { ProjectID } from "@/project/schema"
import { SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import { Timestamps } from "@/storage/schema.sql"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { ExecutionMode, Model, ScheduledTaskID, ScheduledTaskRunID, Status } from "./schema"

export const ScheduledTaskTable = sqliteTable(
  "scheduled_task",
  {
    id: text().$type<ScheduledTaskID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    project_name: text(),
    directory: text().notNull(),
    name: text().notNull(),
    prompt: text().notNull(),
    schedule_kind: text().$type<"at" | "every" | "cron">().notNull(),
    schedule_value: text().notNull(),
    schedule_timezone: text(),
    execution_mode: text().$type<ExecutionMode>().notNull(),
    session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    agent: text().notNull(),
    model: text({ mode: "json" }).$type<Model>().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    unattended: integer({ mode: "boolean" }).notNull().default(true),
    next_run_at: integer(),
    last_run_at: integer(),
    last_status: text().$type<Status>(),
    last_error: text(),
    ...Timestamps,
  },
  (table) => [
    index("scheduled_task_project_idx").on(table.project_id),
    index("scheduled_task_next_run_idx").on(table.enabled, table.next_run_at),
  ],
)

export const ScheduledTaskRunTable = sqliteTable(
  "scheduled_task_run",
  {
    id: text().$type<ScheduledTaskRunID>().primaryKey(),
    task_id: text()
      .$type<ScheduledTaskID>()
      .notNull()
      .references(() => ScheduledTaskTable.id, { onDelete: "cascade" }),
    scheduled_at: integer().notNull(),
    status: text().$type<Status>().notNull(),
    owner_id: text(),
    lease_until: integer(),
    attempt: integer().notNull().default(0),
    session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "set null" }),
    error: text(),
    time_created: integer().notNull(),
    time_started: integer(),
    time_finished: integer(),
  },
  (table) => [
    uniqueIndex("scheduled_task_run_occurrence_idx").on(table.task_id, table.scheduled_at),
    index("scheduled_task_run_task_time_idx").on(table.task_id, table.scheduled_at),
    index("scheduled_task_run_active_idx").on(table.task_id, table.status, table.lease_until),
  ],
)
