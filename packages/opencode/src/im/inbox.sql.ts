import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { IMModel } from "./model"
import type { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { Timestamps } from "@/storage/schema.sql"

export type IMMessageDirection = "inbound" | "outbound"
export type IMLegacyStatus = "received" | "processing" | "completed" | "unknown"
export type IMOutboundStatus = "pending" | "sent" | "unknown" | "failed"

export const IMSequenceTable = sqliteTable("im_sequence", {
  id: text().primaryKey(),
  next_ingest_seq: integer().notNull(),
})

export const IMMessageTable = sqliteTable(
  "im_message",
  {
    id: text().primaryKey(),
    platform: text().$type<IMModel.Platform>().notNull(),
    channel_name: text().notNull(),
    event_id: text().notNull(),
    ingest_seq: integer().notNull().default(0),
    direction: text().$type<IMMessageDirection>().notNull(),
    legacy_status: text().$type<IMLegacyStatus>().notNull().default("received"),
    scope: text().$type<IMModel.TargetScope>().notNull(),
    conversation_id: text().notNull(),
    sender_id: text(),
    sender_name: text(),
    reply_to: text(),
    text: text().notNull(),
    time_event: integer(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("im_message_channel_event_idx").on(table.channel_name, table.event_id),
    index("im_message_channel_conversation_time_idx").on(
      table.channel_name,
      table.conversation_id,
      table.time_created,
      table.id,
    ),
    index("im_message_time_created_id_idx").on(table.time_created, table.id),
  ],
)

export const IMAttachmentTable = sqliteTable(
  "im_attachment",
  {
    id: text().primaryKey(),
    message_id: text()
      .notNull()
      .references(() => IMMessageTable.id, { onDelete: "cascade" }),
    ordinal: integer().notNull(),
    kind: text().$type<"image" | "voice" | "file" | "video">().notNull(),
    mime: text().notNull(),
    filename: text(),
    size: integer().notNull(),
    sha256: text(),
    status: text().$type<"ready" | "unavailable" | "rejected">().notNull(),
    reason: text(),
    data: blob({ mode: "buffer" }).$type<Buffer>(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("im_attachment_message_ordinal_idx").on(table.message_id, table.ordinal)],
)

export const IMOutboundTable = sqliteTable(
  "im_outbound",
  {
    id: text().notNull(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    platform: text().$type<IMModel.Platform>().notNull(),
    channel_name: text().notNull(),
    mode: text().$type<IMModel.SendMode>().notNull(),
    target: text({ mode: "json" }).$type<IMModel.Target>().notNull(),
    provider_sequence_key: text(),
    provider_sequence: integer(),
    text: text().notNull(),
    status: text().$type<IMOutboundStatus>().notNull(),
    format: text().$type<IMModel.MessageFormat>().notNull().default("text"),
    provider_message_id: text(),
    attempt_count: integer().notNull().default(0),
    last_error: text(),
    lease_expires_at: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.project_id, table.id], name: "im_outbound_project_id_id_pk" }),
    index("im_outbound_channel_status_time_idx").on(table.channel_name, table.status, table.time_created),
    index("im_outbound_status_lease_idx").on(table.status, table.lease_expires_at),
  ],
)

export * as IMInboxSQL from "./inbox.sql"
