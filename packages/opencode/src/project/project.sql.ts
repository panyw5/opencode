import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { ProjectID } from "./schema"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: text({ mode: "json" }).notNull().$type<string[]>(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

/**
 * Live production/test DBs already contain this table (upstream ledger ids
 * add_project_directories / project_dir_strategy). Declared so managed schema
 * matches disk; physical ensure lives in storage/upstream-migration.ts.
 */
export const ProjectDirectoryTable = sqliteTable(
  "project_directory",
  {
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: text().notNull(),
    type: text(),
    strategy: text(),
    time_created: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.directory], name: "project_directory_pk" })],
)
