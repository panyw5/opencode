import { expect } from "bun:test"
import { Effect } from "effect"
import { IM } from "../../src/im/service"
import { messageRecordID, NormalizedMessage, Target } from "../../src/im/model"
import { Database, eq } from "../../src/storage/db"
import { IMAttachmentTable, IMMessageTable } from "../../src/im/inbox.sql"
import { testEffect } from "../lib/effect"

const it = testEffect(IM.defaultLayer)

it.effect("persists media atomically, deduplicates it, hides bytes from reads and cascades deletion", () =>
  Effect.gen(function* () {
    const im = yield* IM.Service
    const channelName = `wechat-media-${crypto.randomUUID()}`
    const eventID = "media-event"
    const message = new NormalizedMessage({
      id: messageRecordID("wechat", channelName, eventID),
      platform: "wechat",
      channelName,
      eventID,
      senderID: "owner",
      target: new Target({
        platform: "wechat",
        channelName,
        scope: "c2c",
        conversationID: "owner",
        senderID: "owner",
        replyTo: eventID,
      }),
      text: "[WeChat media attachment]",
      attachments: [
        {
          id: `imatt_${crypto.randomUUID()}`,
          kind: "image",
          mime: "image/png",
          filename: "image.png",
          size: 4,
          sha256: "hash",
          status: "ready",
          data: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    })
    const first = yield* im.ingest({ message })
    expect(first.inserted).toBe(true)
    expect([...first.message.attachments![0]!.data!]).toEqual([1, 2, 3, 4])
    const duplicate = yield* im.ingest({ message: new NormalizedMessage({ ...message, attachments: [] }) })
    expect(duplicate.inserted).toBe(false)
    expect([...duplicate.message.attachments![0]!.data!]).toEqual([1, 2, 3, 4])
    const page = yield* im.list({ channelName, conversationID: "owner", limit: 10 })
    expect(page.items[0]?.attachments?.[0]).toMatchObject({
      kind: "image",
      mime: "image/png",
      size: 4,
      status: "ready",
    })
    expect(page.items[0]?.attachments?.[0]?.data).toBeUndefined()
    Database.use((db) => db.delete(IMMessageTable).where(eq(IMMessageTable.id, message.id)).run())
    expect(
      Database.use((db) =>
        db.select().from(IMAttachmentTable).where(eq(IMAttachmentTable.message_id, message.id)).all(),
      ),
    ).toEqual([])
  }),
)
