import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const SessionContentSearchProgressTable = sqliteTable("session_content_search_progress", {
  id: integer().primaryKey(),
  enabled: integer().notNull().default(0),
  state: text().notNull().default("paused"),
  indexed: integer().notNull(),
  total: integer().notNull(),
  cursor: text(),
  complete: integer().notNull(),
  generation: integer().notNull().default(0),
})
