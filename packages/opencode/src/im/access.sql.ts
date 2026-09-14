import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@/project/project.sql"
import type { ProjectID } from "@/project/schema"
import type { IMModel } from "./model"
import { Timestamps } from "@/storage/schema.sql"

export const IMAccessTable = sqliteTable(
  "im_access",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    platform: text().$type<IMModel.Platform>().notNull(),
    channel_name: text().notNull(),
    scope: text().$type<IMModel.TargetScope>().notNull(),
    conversation_id: text().notNull(),
    can_read: integer({ mode: "boolean" }).notNull().default(false),
    can_send: integer({ mode: "boolean" }).notNull().default(false),
    can_watch: integer({ mode: "boolean" }).notNull().default(false),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("im_access_project_target_idx").on(
      table.project_id,
      table.platform,
      table.channel_name,
      table.scope,
      table.conversation_id,
    ),
    index("im_access_project_read_idx").on(table.project_id, table.can_read),
  ],
)

export * as IMAccessSQL from "./access.sql"
