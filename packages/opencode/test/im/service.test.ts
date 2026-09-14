import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { IM, Service } from "../../src/im/service"
import { Capabilities, NormalizedMessage, Target, messageRecordID } from "../../src/im/model"
import { registry, transportCapabilities } from "../../src/im/transport"
import type { IMTransport } from "../../src/im/model"
import { testEffect } from "../lib/effect"
import { ProjectID } from "../../src/project/schema"
import { ProjectTable } from "../../src/project/project.sql"
import { and, Database, eq } from "../../src/storage/db"
import { IMOutboundTable } from "../../src/im/inbox.sql"
import { createFeishuTransport } from "../../src/channel/feishu"
import { createQQTransport } from "../../src/channel/qq"
import { ProviderRejectedError } from "../../src/im/transport"

function projectID() {
  const id = ProjectID.ascending()
  const now = Date.now()
  Database.use((db) =>
    db.insert(ProjectTable).values({ id, worktree: "/tmp", time_created: now, time_updated: now, sandboxes: [] }).run(),
  )
  return id
}

const it = testEffect(IM.defaultLayer)

function message(eventID: string, text: string, conversationID = "chat-1") {
  return new NormalizedMessage({
    id: messageRecordID("feishu", "test", eventID),
    platform: "feishu",
    channelName: "test",
    eventID,
    target: new Target({
      platform: "feishu",
      channelName: "test",
      scope: "chat",
      conversationID,
      replyTo: eventID,
    }),
    senderID: "user-1",
    text,
  })
}

describe("IM service", () => {
  it.effect("records QQ explicit rejection as failed but preserves network uncertainty", () =>
    Effect.gen(function* () {
      const service = yield* Service
      const channelName = `qq-reject-${crypto.randomUUID()}`
      let rejection = true
      registry.register(
        createQQTransport({
          name: channelName,
          apiBase: "http://localhost/mock",
          getToken: async () => "test",
          requestJson: async () => {
            if (rejection) throw new ProviderRejectedError("qq", 403, 123)
            throw new Error("network unavailable")
          },
        }),
      )
      try {
        const input = {
          projectID: projectID(),
          platform: "qq" as const,
          channelName,
          mode: "proactive" as const,
          target: new Target({ platform: "qq", channelName, scope: "c2c", conversationID: "private:test" }),
          text: "hello",
        }
        expect((yield* service.sendText({ ...input, id: "rejected" })).status).toBe("failed")
        rejection = false
        expect((yield* service.sendText({ ...input, id: "uncertain" })).status).toBe("unknown")
      } finally {
        registry.unregister(channelName)
      }
    }),
  )
  it.effect("records explicit Feishu HTTP rejection as failed and ambiguous transport failure as unknown", () =>
    Effect.gen(function* () {
      const service = yield* Service
      const channelName = `reject-${crypto.randomUUID()}`
      let status = 400
      const transport = createFeishuTransport({
        name: channelName,
        client: {
          im: {
            message: {
              create: async () => {
                throw { response: { status }, config: { appSecret: "must-not-log" } }
              },
            },
          },
        } as never,
      })
      registry.register(transport)
      try {
        const input = {
          id: `reject-${crypto.randomUUID()}`,
          projectID: projectID(),
          channelName,
          platform: "feishu" as const,
          mode: "proactive" as const,
          target: new Target({ platform: "feishu", channelName, scope: "chat", conversationID: "oc_private" }),
          text: "hello",
        }
        const rejected = yield* service.sendText(input)
        expect(rejected.status).toBe("failed")
        expect(rejected.lastError).toContain("HTTP 400")
        expect(rejected.lastError).not.toContain("must-not-log")
        status = 500
        expect((yield* service.sendText({ ...input, id: `uncertain-${crypto.randomUUID()}` })).status).toBe("unknown")
      } finally {
        registry.unregister(channelName, transport)
      }
    }),
  )
  it.effect("persists inbound messages idempotently and paginates with a stable cursor", () =>
    Effect.gen(function* () {
      const service = yield* Service
      const first = yield* service.ingest({ message: message(`evt-${crypto.randomUUID()}-1`, "first") })
      const duplicate = yield* service.ingest({ message: message(first.message.eventID, "changed") })
      const duplicateWithDifferentRecordID = yield* service.ingest({
        message: new NormalizedMessage({
          ...message(first.message.eventID, "changed-again"),
          id: `im-other-${crypto.randomUUID()}`,
        }),
      })
      const second = yield* service.ingest({ message: message(`evt-${crypto.randomUUID()}-2`, "second") })
      const project = projectID()

      expect(first.inserted).toBe(true)
      expect(duplicate.inserted).toBe(false)
      expect(duplicate.message.text).toBe("first")
      expect(duplicateWithDifferentRecordID.inserted).toBe(false)
      expect(duplicateWithDifferentRecordID.message.id).toBe(first.message.id)
      const page = yield* service.list({ projectID: project, channelName: "test", conversationID: "chat-1", limit: 1 })
      expect(page.items).toHaveLength(1)
      expect(page.nextCursor).toBeDefined()
      const next = yield* service.list({
        projectID: project,
        channelName: "test",
        conversationID: "chat-1",
        limit: 1,
        cursor: page.nextCursor,
      })
      expect(next.items).toHaveLength(1)
      expect(new Set([page.items[0]!.id, next.items[0]!.id]).size).toBe(2)
      expect([page.items[0]!.text, next.items[0]!.text].toSorted()).toEqual(["first", "second"])
      expect(second.message.id).not.toBe(first.message.id)
    }),
  )

  it.effect("records sent, idempotent, unsupported, and unknown outbound states", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const transport: IMTransport = {
        platform: "feishu",
        channelName: "send-test",
        capabilities: transportCapabilities("feishu"),
        sendText: async ({ text }) => {
          calls.push(text)
          return { providerMessageID: "provider-1", timeSent: Date.now() }
        },
      }
      registry.register(transport)
      try {
        const service = yield* Service
        const target = new Target({
          platform: "feishu",
          channelName: "send-test",
          scope: "chat",
          conversationID: "chat-2",
        })
        const project = projectID()
        const input = {
          id: `send-${crypto.randomUUID()}`,
          projectID: project,
          platform: "feishu",
          channelName: "send-test",
          mode: "proactive",
          target,
          text: "hello",
        } as const
        const sent = yield* service.sendText(input)
        const duplicate = yield* service.sendText(input)
        expect(sent.status).toBe("sent")
        expect(duplicate.status).toBe("sent")
        expect(sent.providerMessageID).toBe("provider-1")
        expect(duplicate).toEqual(sent)
        const receipts = Database.use((db) =>
          db
            .select()
            .from(IMOutboundTable)
            .where(and(eq(IMOutboundTable.project_id, project), eq(IMOutboundTable.id, input.id)))
            .all(),
        )
        expect(receipts).toHaveLength(1)
        expect(receipts[0]).toMatchObject({ status: "sent", provider_message_id: "provider-1", attempt_count: 1 })
        expect(calls).toEqual(["hello"])
        const concurrentInput = { ...input, id: `send-concurrent-${crypto.randomUUID()}` }
        const concurrent = yield* Effect.all([service.sendText(concurrentInput), service.sendText(concurrentInput)], {
          concurrency: "unbounded",
        })
        expect(new Set(concurrent.map((item) => item.status))).toEqual(new Set(["sent", "pending"]))
        expect(calls).toEqual(["hello", "hello"])
        const conflictID = `send-conflict-${crypto.randomUUID()}`
        const conflicting = yield* Effect.all(
          [
            service.sendText({ ...input, id: conflictID, text: "first payload" }).pipe(Effect.exit),
            service.sendText({ ...input, id: conflictID, text: "second payload" }).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" },
        )
        expect(conflicting.filter(Exit.isSuccess)).toHaveLength(1)
        expect(conflicting.filter(Exit.isFailure)).toHaveLength(1)
        expect(calls.filter((text) => text.includes("payload"))).toHaveLength(1)
      } finally {
        registry.unregister("send-test", transport)
      }
    }),
  )

  it.effect("does not retry unknown sends and records unsupported capability failures", () =>
    Effect.gen(function* () {
      let calls = 0
      const unknown: IMTransport = {
        platform: "qq",
        channelName: "unknown-test",
        capabilities: new Capabilities({
          passiveReply: true,
          proactiveC2C: "limited",
          proactiveGroup: "limited",
          proactiveGuild: "unsupported",
        }),
        sendText: async () => {
          calls++
          throw new Error("connection reset")
        },
      }
      registry.register(unknown)
      try {
        const service = yield* Service
        const target = new Target({
          platform: "qq",
          channelName: "unknown-test",
          scope: "c2c",
          conversationID: "private:u",
        })
        const project = projectID()
        const input = {
          id: `unknown-${crypto.randomUUID()}`,
          projectID: project,
          platform: "qq" as const,
          channelName: "unknown-test",
          mode: "proactive" as const,
          target,
          text: "hello",
        }
        expect((yield* service.sendText(input)).status).toBe("unknown")
        expect((yield* service.sendText(input)).status).toBe("unknown")
        expect(calls).toBe(1)

        const unsupported: IMTransport = {
          ...unknown,
          channelName: "unsupported-test",
          capabilities: new Capabilities({
            passiveReply: true,
            proactiveC2C: "unsupported",
            proactiveGroup: "unsupported",
            proactiveGuild: "unsupported",
          }),
          sendText: async () => {
            throw new Error("must not be called")
          },
        }
        registry.register(unsupported)
        const unsupportedTarget = new Target({
          platform: "qq",
          channelName: "unsupported-test",
          scope: "c2c",
          conversationID: "private:u",
        })
        const failed = yield* service.sendText({
          ...input,
          id: `unsupported-${crypto.randomUUID()}`,
          channelName: "unsupported-test",
          target: unsupportedTarget,
        })
        expect(failed.status).toBe("failed")
        expect(failed.lastError).toContain("unsupported")
        registry.unregister("unsupported-test", unsupported)
      } finally {
        registry.unregister("unknown-test", unknown)
      }
    }),
  )

  it.effect("uses monotonic after checkpoints and filters resolved targets without requiring project ACL", () =>
    Effect.gen(function* () {
      const service = yield* Service
      const conversationID = `chat-after-${crypto.randomUUID()}`
      const first = yield* service.ingest({
        message: message(`after-${crypto.randomUUID()}-1`, "first", conversationID),
      })
      const project = projectID()
      const empty = yield* service.list({ projectID: project, channelName: "test", conversationID, direction: "after" })
      expect(empty.items).toHaveLength(1)
      expect(empty.items[0]?.ingestSeq).toBe(first.message.ingestSeq)
      expect(empty.checkpoint).toBeDefined()
      const second = yield* service.ingest({
        message: message(`after-${crypto.randomUUID()}-2`, "second", conversationID),
      })
      const next = yield* service.list({
        projectID: project,
        channelName: "test",
        conversationID,
        direction: "after",
        cursor: empty.checkpoint,
      })
      expect(next.items.map((item) => item.ingestSeq)).toEqual([second.message.ingestSeq])
      expect(
        Exit.isFailure(
          yield* service.list({ projectID: project, direction: "after", cursor: "not-a-cursor" }).pipe(Effect.exit),
        ),
      ).toBe(true)
      const otherProject = projectID()
      expect(
        (yield* service.list({
          projectID: otherProject,
          channelName: "test",
          conversationID,
          senderID: "other-user",
          direction: "after",
        })).items,
      ).toEqual([])
      expect(
        (yield* service.list({
          projectID: otherProject,
          channelName: "test",
          conversationID,
          senderID: "user-1",
          direction: "after",
        })).items.map((item) => item.id),
      ).toEqual([first.message.id, second.message.id])
    }),
  )

  it.effect("rejects oversized text before making a provider request", () =>
    Effect.gen(function* () {
      const service = yield* Service
      const channelName = `validation-${crypto.randomUUID()}`
      let calls = 0
      const transport: IMTransport = {
        platform: "feishu",
        channelName,
        capabilities: transportCapabilities("feishu"),
        sendText: async () => {
          calls++
          return { timeSent: Date.now() }
        },
      }
      registry.register(transport)
      try {
        const result = yield* service.sendText({
          projectID: projectID(),
          id: "oversized",
          platform: "feishu",
          channelName,
          target: new Target({ platform: "feishu", channelName, scope: "chat", conversationID: "chat" }),
          mode: "proactive",
          text: "x".repeat(4001),
        })
        expect(result.status).toBe("failed")
        expect(result.attemptCount).toBe(0)
        expect(result.lastError).toContain("4000")
        expect(calls).toBe(0)
      } finally {
        registry.unregister(channelName, transport)
      }
    }),
  )

  it.effect("rejects reply targets from another chat and idempotency keys from another project", () =>
    Effect.gen(function* () {
      const service = yield* Service
      const inbound = yield* service.ingest({ message: message(`reply-${crypto.randomUUID()}`, "inbound") })
      const project = projectID()
      const wrongChatTarget = new Target({
        platform: "feishu",
        channelName: "test",
        scope: "chat",
        conversationID: "chat-2",
        replyTo: inbound.message.eventID,
      })
      const input = {
        id: `reply-send-${crypto.randomUUID()}`,
        projectID: project,
        platform: "feishu" as const,
        channelName: "test",
        mode: "reply" as const,
        target: wrongChatTarget,
        text: "reply",
      }
      const invalidReply = yield* service.sendText(input).pipe(Effect.exit)
      expect(Exit.isFailure(invalidReply)).toBe(true)
      const validInput = { ...input, target: inbound.message.target }
      const noTransport = yield* service.sendText(validInput)
      expect(noTransport.status).toBe("failed")
      const otherProject = projectID()
      const independent = yield* service.sendText({ ...validInput, projectID: otherProject })
      expect(independent.status).toBe("failed")
      const conflict = yield* service.sendText({ ...validInput, text: "different" }).pipe(Effect.exit)
      expect(Exit.isFailure(conflict)).toBe(true)
    }),
  )

  it.effect("enforces monotonic legacy processing states", () =>
    Effect.gen(function* () {
      const service = yield* Service
      const messageResult = yield* service.ingest({ message: message(`legacy-${crypto.randomUUID()}`, "legacy") })
      expect(yield* service.markLegacyCompleted(messageResult.message.id)).toBe(false)
      expect(yield* service.markLegacyStatus(messageResult.message.id, "processing")).toBe(true)
      expect(yield* service.markLegacyCompleted(messageResult.message.id)).toBe(true)
      expect(yield* service.markLegacyStatus(messageResult.message.id, "processing")).toBe(false)
      expect(yield* service.markLegacyStatus(messageResult.message.id, "unknown")).toBe(false)
    }),
  )

  it.effect("shares bounded QQ reply sequences across legacy and project senders", () =>
    Effect.gen(function* () {
      const service = yield* Service
      const target = new Target({
        platform: "qq",
        channelName: "sequence-test",
        scope: "c2c",
        conversationID: "private:user",
        replyTo: "msg-1",
      })
      expect(
        yield* service.reserveProviderSequence({ platform: "qq", channelName: "sequence-test", target, mode: "reply" }),
      ).toBeGreaterThan(0)
      expect(
        yield* service.reserveProviderSequence({ platform: "qq", channelName: "sequence-test", target, mode: "reply" }),
      ).toBe(2)
      const other = new Target({ ...target, replyTo: "msg-2" })
      expect(
        yield* service.reserveProviderSequence({
          platform: "qq",
          channelName: "sequence-test",
          target: other,
          mode: "reply",
        }),
      ).toBe(1)
    }),
  )
})
