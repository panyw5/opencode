import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

/**
 * Present on live production/test DBs (migration id 20260611035744_credential).
 * Declared for schema ⊇ live alignment; ensure/create in upstream-migration.
 */
export const CredentialTable = sqliteTable("credential", {
  id: text().primaryKey(),
  integration_id: text(),
  label: text().notNull(),
  value: text().notNull(),
  connector_id: text(),
  method_id: text(),
  active: integer(),
  ...Timestamps,
})
