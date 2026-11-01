import { sqliteTable, text, index, primaryKey } from "drizzle-orm/sqlite-core"
import { MessageTable, SessionTable } from "./session.sql"
import type { MessageID, SessionID } from "./schema"

export const InstructionSnapshotTable = sqliteTable(
  "session_instruction_snapshot",
  {
    source: text().notNull(),
    message_id: text()
      .$type<MessageID>()
      .notNull()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    hash: text().notNull(),
    snapshot: text({ mode: "json" }).$type<unknown>().notNull(),
    kind: text().$type<"initial" | "update">().notNull(),
    text: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.message_id] }),
    index("session_instruction_snapshot_session_idx").on(table.session_id),
  ],
)
