import { ProjectTable } from "@/project/project.sql"
import type { ProjectID } from "@/project/schema"
import { Timestamps } from "@/storage/schema.sql"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { ProjectTaskID, Status } from "./schema"

export const ProjectTaskTable = sqliteTable(
  "project_task",
  {
    id: text().$type<ProjectTaskID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    title: text().notNull(),
    /**
     * Legacy inline description. New writes keep this empty; content lives in
     * `description_path` (typically `.tasks/<taskID>/description.md`).
     */
    description: text().notNull().default(""),
    /** Project-relative path to the user-visible description markdown file. */
    description_path: text(),
    status: text().$type<Status>().notNull().default("open"),
    // Legacy priority column may still exist in older DBs; not mapped or used.
    time_archived: integer(),
    ...Timestamps,
  },
  (table) => [
    index("project_task_project_idx").on(table.project_id),
    index("project_task_project_status_updated_idx").on(table.project_id, table.status, table.time_updated),
    index("project_task_project_archived_updated_idx").on(table.project_id, table.time_archived, table.time_updated),
  ],
)
