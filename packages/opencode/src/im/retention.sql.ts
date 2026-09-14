import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { ProjectID } from "@/project/schema"
import { Timestamps } from "@/storage/schema.sql"
import type { IMModel } from "./model"

export const IMMessageTombstoneTable = sqliteTable(
  "im_message_tombstone",
  {
    id: text().primaryKey(),
    platform: text().$type<IMModel.Platform>().notNull(),
    channel_name: text().notNull(),
    event_id: text().notNull(),
    ingest_seq: integer().notNull(),
    payload_hash: text().notNull(),
    legacy_status: text().notNull(),
    ...Timestamps,
  },
  (table) => [index("im_message_tombstone_channel_event_idx").on(table.channel_name, table.event_id)],
)

export const IMOutboundTombstoneTable = sqliteTable(
  "im_outbound_tombstone",
  {
    id: text().notNull(),
    project_id: text().$type<ProjectID>().notNull(),
    platform: text().$type<IMModel.Platform>().notNull(),
    channel_name: text().notNull(),
    payload_hash: text().notNull(),
    status: text().notNull(),
    provider_message_id: text(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.project_id, table.id], name: "im_outbound_tombstone_project_id_id_pk" })],
)

export * as IMRetentionSQL from "./retention.sql"
