import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import { ProjectTable } from "./project.sql"
import type { LocationID, ProjectAliasID, ProjectID } from "./schema"

export type ProjectLocationKind = "directory" | "git_main" | "git_worktree" | "git_clone"
export type ProjectLocationVcsType = "git"
export type ProjectLocationVcsState = "none" | "unborn" | "ready" | "unavailable" | "error"
export type ProjectAliasKind = "git_marker" | "provider_repo" | "remote_url" | "root_commit"
export type ProjectAliasConfidence = "high" | "medium" | "low"

export const ProjectLocationTable = sqliteTable(
  "project_location",
  {
    id: text().$type<LocationID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: text().notNull(),
    canonical_directory: text().notNull(),
    kind: text().$type<ProjectLocationKind>().notNull(),
    vcs_type: text().$type<ProjectLocationVcsType>(),
    vcs_state: text().$type<ProjectLocationVcsState>().notNull(),
    worktree_root: text(),
    git_common_dir: text(),
    marker: text(),
    ...Timestamps,
    time_last_seen: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("project_location_canonical_directory_idx").on(table.canonical_directory),
    index("project_location_project_idx").on(table.project_id),
    index("project_location_git_common_dir_idx").on(table.git_common_dir),
  ],
)

export const ProjectAliasTable = sqliteTable(
  "project_alias",
  {
    id: text().$type<ProjectAliasID>().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    kind: text().$type<ProjectAliasKind>().notNull(),
    value: text().notNull(),
    confidence: text().$type<ProjectAliasConfidence>().notNull(),
    source_location_id: text()
      .$type<LocationID>()
      .references(() => ProjectLocationTable.id, { onDelete: "set null" }),
    ...Timestamps,
    time_last_seen: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    uniqueIndex("project_alias_project_kind_value_idx").on(table.project_id, table.kind, table.value),
    index("project_alias_kind_value_idx").on(table.kind, table.value),
    index("project_alias_project_idx").on(table.project_id),
    index("project_alias_source_location_idx").on(table.source_location_id),
  ],
)
