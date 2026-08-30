import { index, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectLocationTable } from "@/project/location.sql"
import { ProjectTable } from "@/project/project.sql"
import type { LocationID, ProjectID } from "@/project/schema"
import { Timestamps } from "@/storage/schema.sql"
import type { Ruleset } from "."

export type PermissionScope = "global" | "project" | "location"

export const PermissionScopeTable = sqliteTable(
  "permission_scope",
  {
    id: text().primaryKey(),
    scope: text().$type<PermissionScope>().notNull(),
    project_id: text()
      .$type<ProjectID>()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    location_id: text()
      .$type<LocationID>()
      .references(() => ProjectLocationTable.id, { onDelete: "cascade" }),
    data: text({ mode: "json" }).notNull().$type<Ruleset>(),
    ...Timestamps,
  },
  (table) => [index("permission_scope_project_idx").on(table.project_id), index("permission_scope_location_idx").on(table.location_id)],
)
