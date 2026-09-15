import { expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { IM } from "../../src/im/service"
import { IMRetention, outboundFingerprint } from "../../src/im/retention"
import { IMOutboundTable } from "../../src/im/inbox.sql"
import { ProjectID } from "../../src/project/schema"
import { ProjectTable } from "../../src/project/project.sql"
import { Database, and, eq } from "../../src/storage/db"
import { Target } from "../../src/im/model"
import { registry } from "../../src/im/transport"
import { createFeishuTransport } from "../../src/channel/feishu"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(IM.defaultLayer, IMRetention.defaultLayer))
it.effect("renders rich cards without fallback, persists format and protects idempotency after cleanup", () =>
  Effect.gen(function* () {
    const service = yield* IM.Service
    const retention = yield* IMRetention.Service
    const projectID = ProjectID.ascending()
    const channelName = `markdown-${crypto.randomUUID()}`
    Database.use((db) =>
      db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: "/tmp", sandboxes: [], time_created: Date.now(), time_updated: Date.now() })
        .run(),
    )
    const calls: any[] = []
    let reject = false
    registry.register(
      createFeishuTransport({
        name: channelName,
        client: {
          im: {
            message: {
              create: async (input: any) => {
                calls.push(input)
                if (reject) throw { response: { status: 400 } }
                return { code: 0, data: { message_id: "rich-provider" } }
              },
            },
          },
        } as any,
      }),
    )
    try {
      const input = {
        projectID,
        channelName,
        platform: "feishu" as const,
        mode: "proactive" as const,
        target: new Target({ platform: "feishu", channelName, scope: "chat", conversationID: "chat" }),
        text: "**Heading**\n- item\n" + "x".repeat(5000),
      }
      const rich = yield* service.sendText({ ...input, id: "rich", format: "markdown" })
      expect(rich).toMatchObject({ status: "sent", format: "markdown", attemptCount: 1 })
      expect(calls[0].data.msg_type).toBe("interactive")
      const card = JSON.parse(calls[0].data.content)
      expect(card.schema).toBe("2.0")
      expect(card.body.elements).toEqual([{ tag: "markdown", content: input.text }])
      expect((yield* service.sendText({ ...input, id: "rich", format: "markdown" })).status).toBe("sent")
      expect(Exit.isFailure(yield* service.sendText({ ...input, id: "rich", format: "text" }).pipe(Effect.exit))).toBe(
        true,
      )
      expect(calls).toHaveLength(1)
      Database.use((db) =>
        db
          .update(IMOutboundTable)
          .set({ time_created: Date.now() - 3 * 86400000 })
          .where(and(eq(IMOutboundTable.project_id, projectID), eq(IMOutboundTable.id, "rich")))
          .run(),
      )
      yield* retention.cleanup([{ channelName, retentionDays: 1 }])
      expect((yield* service.sendText({ ...input, id: "rich", format: "markdown" })).status).toBe("sent")
      expect(Exit.isFailure(yield* service.sendText({ ...input, id: "rich" }).pipe(Effect.exit))).toBe(true)
      expect(calls).toHaveLength(1)
      const plain = yield* service.sendText({ ...input, id: "plain", text: "**literal text**" })
      expect(plain.format).toBe("text")
      expect(calls[1].data.msg_type).toBe("text")
      const oversized = yield* service.sendText({
        ...input,
        id: "oversized",
        format: "markdown",
        text: "x".repeat(12001),
      })
      expect(oversized).toMatchObject({ status: "failed", attemptCount: 0 })
      const unsupported = yield* service.sendText({
        ...input,
        id: "qq",
        platform: "qq",
        format: "markdown",
        target: new Target({ platform: "qq", channelName, scope: "c2c", conversationID: "private:user" }),
      })
      expect(unsupported).toMatchObject({ status: "failed", attemptCount: 0 })
      reject = true
      expect((yield* service.sendText({ ...input, id: "rejected", format: "markdown" })).status).toBe("failed")
      expect(calls).toHaveLength(3)
      const fingerprint = {
        platform: input.platform,
        channelName,
        mode: input.mode,
        target: input.target,
        text: "legacy",
      }
      expect(outboundFingerprint(fingerprint)).toBe(outboundFingerprint({ ...fingerprint, format: "text" }))
      expect(outboundFingerprint(fingerprint)).not.toBe(outboundFingerprint({ ...fingerprint, format: "markdown" }))
    } finally {
      registry.unregister(channelName)
      Database.use((db) => db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run())
    }
  }),
)
