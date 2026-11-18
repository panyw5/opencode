import { Effect } from "effect"
import { Database, eq } from "@/storage/db"
import { IMMessageTable } from "./inbox.sql"
import { runtime } from "./service"
import { InstanceState } from "@/effect/instance-state"

// The durable outbound key deduplicates retries; target comes only from the inbox.
export const permissionReceipt = Effect.fn("IM.permissionReceipt")(function* (
  messageID: string,
  permission: string,
  key: string,
) {
  const row = Database.use((db) => db.select().from(IMMessageTable).where(eq(IMMessageTable.id, messageID)).get())
  if (!row) return yield* Effect.die(new Error(`IM denial receipt origin is missing: ${messageID}`))
  const instance = yield* InstanceState.context
  const result = yield* Effect.promise((signal) =>
    runtime.runPromise(
      (service) =>
        service.sendText({
          id: `permission-denied:${messageID}:${key}`,
          projectID: instance.project.id,
          platform: row.platform,
          channelName: row.channel_name,
          mode: "reply",
          target: {
            platform: row.platform,
            channelName: row.channel_name,
            scope: row.scope,
            conversationID: row.conversation_id,
            replyTo: row.event_id,
          },
          text: `操作已停止：权限 ${permission} 被明确的 deny 规则拒绝。其他操作可继续执行。`,
        }),
      { signal },
    ),
  )
  if (result.status !== "sent")
    return yield* Effect.die(new Error(`IM denial receipt delivery ${result.status}: ${result.id}`))
})
