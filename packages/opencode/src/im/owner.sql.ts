import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "@/storage/schema.sql"

export const IMOwnerTable = sqliteTable("im_owner", {
  channel_name: text().primaryKey(),
  app_identity: text().notNull(),
  platform: text().$type<"feishu" | "qq" | "wechat">().notNull(),
  conversation_id: text().notNull(),
  sender_id: text().notNull(),
  name: text(),
  ...Timestamps,
})

export * as IMOwnerSQL from "./owner.sql"
