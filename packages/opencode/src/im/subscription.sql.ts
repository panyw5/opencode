import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "@/project/project.sql"
import type { ProjectID } from "@/project/schema"
import { SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import { Timestamps } from "@/storage/schema.sql"
import type { IMModel } from "./model"

export type IMSubscriptionStatus = "active" | "paused" | "stopped" | "failed"

export const IMSubscriptionTable = sqliteTable(
  "im_subscription",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    platform: text().$type<IMModel.Platform>().notNull(),
    channel_name: text().notNull(),
    scope: text().$type<IMModel.TargetScope>().notNull(),
    conversation_id: text().notNull(),
    sender_id: text(),
    keyword: text(),
    status: text().$type<IMSubscriptionStatus>().notNull().default("active"),
    failure_reason: text(),
    start_seq: integer().notNull().default(0),
    delivery_cursor: integer().notNull().default(-1),
    ...Timestamps,
  },
  (table) => [
    index("im_subscription_project_status_idx").on(table.project_id, table.status),
    index("im_subscription_target_status_idx").on(
      table.platform,
      table.channel_name,
      table.scope,
      table.conversation_id,
      table.status,
    ),
  ],
)

export const IMSubscriptionDeliveryTable = sqliteTable(
  "im_subscription_delivery",
  {
    subscription_id: text()
      .notNull()
      .references(() => IMSubscriptionTable.id, { onDelete: "cascade" }),
    message_id: text().notNull(),
    ingest_seq: integer().notNull(),
    status: text().notNull().default("admitted"),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.subscription_id, table.message_id], name: "im_subscription_delivery_pk" }),
    index("im_subscription_delivery_seq_idx").on(table.subscription_id, table.ingest_seq),
  ],
)

export * as IMSubscriptionSQL from "./subscription.sql"
