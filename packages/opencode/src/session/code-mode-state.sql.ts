import { sqliteTable, text, index } from "drizzle-orm/sqlite-core"
import { MessageTable, SessionTable } from "./session.sql"
import type { MessageID, SessionID } from "./schema"
import type { CodeModeCatalog } from "./code-mode-catalog"

export const CodeModeInstructionTable = sqliteTable(
  "code_mode_instruction",
  {
    message_id: text()
      .$type<MessageID>()
      .primaryKey()
      .references(() => MessageTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    hash: text().notNull(),
    snapshot: text({ mode: "json" }).$type<CodeModeCatalog.Summary>().notNull(),
    kind: text().$type<"initial" | "update">().notNull(),
    text: text().notNull(),
  },
  (table) => [index("code_mode_instruction_session_idx").on(table.session_id)],
)
