import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { Info, Occurrence } from "./issue"

export const IssueTable = sqliteTable(
  "issue",
  {
    id: text().primaryKey(),
    directory: text().notNull(),
    session_id: text(),
    time_updated: integer().notNull(),
    data: text({ mode: "json" }).$type<Info>().notNull(),
  },
  (table) => [
    index("issue_directory_time_idx").on(table.directory, table.time_updated, table.id),
    index("issue_session_idx").on(table.session_id),
  ],
)

export const IssueOccurrenceTable = sqliteTable(
  "issue_occurrence",
  {
    id: text().primaryKey(),
    issue_id: text()
      .notNull()
      .references(() => IssueTable.id, { onDelete: "cascade" }),
    data: text({ mode: "json" }).$type<Occurrence>().notNull(),
  },
  (table) => [index("issue_occurrence_issue_idx").on(table.issue_id, table.id)],
)
