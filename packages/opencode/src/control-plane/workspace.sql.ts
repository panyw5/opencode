import { index, sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import { ProjectLocationTable } from "../project/location.sql"
import type { LocationID, ProjectID } from "../project/schema"
import type { WorkspaceID } from "./schema"

export const WorkspaceTable = sqliteTable(
  "workspace",
  {
    id: text().$type<WorkspaceID>().primaryKey(),
    type: text().notNull(),
    name: text().notNull().default(""),
    branch: text(),
    directory: text(),
    location_id: text()
      .$type<LocationID>()
      .references(() => ProjectLocationTable.id, { onDelete: "set null" }),
    extra: text({ mode: "json" }),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    time_used: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [index("workspace_location_idx").on(table.location_id)],
)
