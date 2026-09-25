import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectLocationTable } from "@/project/location.sql"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable } from "@/session/session.sql"
import type { LocationID, ProjectID } from "@/project/schema"
import type { SessionID } from "@/session/schema"

/** Durable ID-only Math problem registry. Paths are always derived at runtime. */
export const MathProblemTable = sqliteTable(
  "math_problem",
  {
    parent_session_id: text().$type<SessionID>().notNull(),
    problem_id: text().notNull(),
    owner_project_id: text().$type<ProjectID>().notNull(),
    owner_location_id: text().$type<LocationID>(),
    orchestrator_session_id: text().$type<SessionID>().notNull(),
    legacy: integer({ mode: "boolean" }).notNull().default(false),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.parent_session_id, table.problem_id] }),
    foreignKey({ columns: [table.parent_session_id], foreignColumns: [SessionTable.id] }).onDelete("cascade"),
    foreignKey({ columns: [table.orchestrator_session_id], foreignColumns: [SessionTable.id] }).onDelete("cascade"),
    foreignKey({ columns: [table.owner_project_id], foreignColumns: [ProjectTable.id] }).onDelete("cascade"),
    foreignKey({ columns: [table.owner_location_id], foreignColumns: [ProjectLocationTable.id] }).onDelete("set null"),
    index("math_problem_owner_idx").on(table.owner_project_id, table.owner_location_id),
  ],
)

export const MathProblemWorkerTable = sqliteTable(
  "math_problem_worker",
  {
    parent_session_id: text().$type<SessionID>().notNull(),
    problem_id: text().notNull(),
    worker_session_id: text().$type<SessionID>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.parent_session_id, table.problem_id, table.worker_session_id] }),
    foreignKey({ columns: [table.parent_session_id, table.problem_id], foreignColumns: [MathProblemTable.parent_session_id, MathProblemTable.problem_id] }).onDelete("cascade"),
    foreignKey({ columns: [table.worker_session_id], foreignColumns: [SessionTable.id] }).onDelete("cascade"),
    uniqueIndex("math_problem_worker_session_idx").on(table.worker_session_id),
  ],
)
