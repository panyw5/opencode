import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { IMSubscription } from "../../src/im/subscription"
import { IM, Service as IMService } from "../../src/im/service"
import { NormalizedMessage, Target } from "../../src/im/model"
import { ProjectID } from "../../src/project/schema"
import { ProjectTable } from "../../src/project/project.sql"
import { SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database } from "../../src/storage/db"
import { testEffect } from "../lib/effect"
import { IMOwner } from "../../src/im/owner"

const currentOwners = new Map<string, Target>()
const ownerLayer = Layer.succeed(IMOwner.Service, {
  resolve: (channelName) =>
    currentOwners.has(channelName)
      ? Effect.succeed(currentOwners.get(channelName)!)
      : Effect.fail(new IMOwner.OwnerNotReadyError({ channelName })),
  list: () => Effect.succeed([]),
  observe: () => Effect.void,
})
const it = testEffect(Layer.mergeAll(IM.defaultLayer, IMSubscription.layer.pipe(Layer.provide(ownerLayer))))

function seed() {
  const projectID = ProjectID.ascending()
  const sessionID = SessionID.descending()
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({ id: projectID, worktree: "/tmp", time_created: now, time_updated: now, sandboxes: [] })
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "subscription-test",
        directory: "/tmp",
        title: "Subscription",
        version: "test",
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return { projectID, sessionID }
}

describe("IM subscriptions", () => {
  it.effect("rejects new admission for stale recipient and legacy group or senderless snapshots", () =>
    Effect.gen(function* () {
      const subscriptions = yield* IMSubscription.Service
      const { projectID, sessionID } = seed()
      const channelName = `owner-change-${crypto.randomUUID()}`
      const ownerA = new Target({
        platform: "feishu",
        channelName,
        scope: "chat",
        conversationID: "oc_a",
        senderID: "u_a",
      })
      const ownerB = new Target({ ...ownerA, conversationID: "oc_b", senderID: "u_b" })
      currentOwners.set(channelName, ownerA)
      const active = yield* subscriptions.create({ projectID, sessionID, sessionDirectory: "/tmp", target: ownerA })
      const messageA = {
        messageID: "a",
        platform: "feishu" as const,
        channelName,
        scope: "chat" as const,
        conversationID: "oc_a",
        senderID: "u_a",
        text: "message",
        ingestSeq: active.startSeq + 1,
      }
      expect(yield* subscriptions.matching(messageA)).toHaveLength(1)
      currentOwners.set(channelName, ownerB)
      expect(yield* subscriptions.matching(messageA)).toHaveLength(0)
      const legacyGroup = new Target({ ...ownerB, conversationID: "oc_group" })
      yield* subscriptions.create({ projectID, sessionID, sessionDirectory: "/tmp", target: legacyGroup })
      expect(yield* subscriptions.matching({ ...messageA, conversationID: "oc_group", senderID: "u_b" })).toHaveLength(
        0,
      )
      yield* subscriptions.create({
        projectID,
        sessionID,
        sessionDirectory: "/tmp",
        target: new Target({ platform: "feishu", channelName, scope: "chat", conversationID: "oc_b" }),
      })
      expect(yield* subscriptions.matching({ ...messageA, conversationID: "oc_b", senderID: "u_b" })).toHaveLength(0)
      yield* subscriptions.create({ projectID, sessionID, sessionDirectory: "/tmp", target: ownerB })
      expect(yield* subscriptions.matching({ ...messageA, conversationID: "oc_b", senderID: "u_b" })).toHaveLength(1)
      currentOwners.delete(channelName)
      expect(yield* subscriptions.matching({ ...messageA, conversationID: "oc_b", senderID: "u_b" })).toHaveLength(0)
    }),
  )
  it.effect("requires a matching project session, filters sender and substring keyword, and advances durably", () =>
    Effect.gen(function* () {
      const subscriptions = yield* IMSubscription.Service
      const { projectID, sessionID } = seed()
      const target = new Target({
        platform: "feishu",
        channelName: "subscription-test",
        scope: "chat",
        conversationID: "chat-1",
      })
      currentOwners.set(target.channelName, new Target({ ...target, senderID: "u1" }))
      expect(
        yield* subscriptions
          .create({
            projectID,
            sessionID,
            sessionDirectory: "/wrong-project",
            target,
            senderID: "u1",
            keyword: "urgent",
          })
          .pipe(Effect.exit),
      ).toMatchObject({ _tag: "Failure" })
      const created = yield* subscriptions.create({
        projectID,
        sessionID,
        sessionDirectory: "/tmp",
        target,
        senderID: "u1",
        keyword: "urgent",
      })
      expect(created.status).toBe("active")
      const nextSeq = created.startSeq + 1
      const matched = yield* subscriptions.matching({
        messageID: "message-1",
        platform: "feishu",
        channelName: "subscription-test",
        scope: "chat",
        conversationID: "chat-1",
        senderID: "u1",
        text: "very urgent item",
        ingestSeq: nextSeq,
      })
      expect(matched).toHaveLength(1)
      expect(
        (yield* subscriptions.matching({
          messageID: "message-1",
          platform: "feishu",
          channelName: "subscription-test",
          scope: "chat",
          conversationID: "chat-1",
          senderID: "u2",
          text: "very urgent item",
          ingestSeq: nextSeq,
        })).length,
      ).toBe(0)
      expect(yield* subscriptions.recordDelivery(created.id, "message-1", nextSeq)).toBe(true)
      expect(yield* subscriptions.advance(created.id, nextSeq)).toBe(true)
      expect(
        (yield* subscriptions.matching({
          messageID: "message-1",
          platform: "feishu",
          channelName: "subscription-test",
          scope: "chat",
          conversationID: "chat-1",
          senderID: "u1",
          text: "very urgent item",
          ingestSeq: nextSeq,
        })).length,
      ).toBe(0)
      expect(
        (yield* subscriptions.matching({
          messageID: "message-2",
          platform: "feishu",
          channelName: "subscription-test",
          scope: "chat",
          conversationID: "chat-1",
          senderID: "u1",
          text: "very urgent item",
          ingestSeq: nextSeq + 1,
        })).length,
      ).toBe(1)
      expect((yield* subscriptions.pause(created.id, projectID)).status).toBe("paused")
      expect((yield* subscriptions.resume(created.id, projectID)).status).toBe("active")
      expect((yield* subscriptions.stop(created.id, projectID)).status).toBe("stopped")
      expect((yield* subscriptions.list(projectID)).map((item) => item.sessionDirectory)).toEqual(["/tmp"])
    }),
  )

  it.effect("records subscription ownership and completes legacy state atomically", () =>
    Effect.gen(function* () {
      const subscriptions = yield* IMSubscription.Service
      const im = yield* IMService
      const { projectID, sessionID } = seed()
      const target = new Target({
        platform: "feishu",
        channelName: "ownership-test",
        scope: "chat",
        conversationID: "chat",
      })
      const subscription = yield* subscriptions.create({ projectID, sessionID, sessionDirectory: "/tmp", target })
      const message = yield* im.ingest({
        message: new NormalizedMessage({
          id: `ownership-${crypto.randomUUID()}`,
          platform: "feishu",
          channelName: "ownership-test",
          eventID: `evt-${crypto.randomUUID()}`,
          target,
          text: "owned",
        }),
      })
      yield* im.markLegacyStatus(message.message.id, "processing")
      expect(yield* subscriptions.recordDelivery(subscription.id, message.message.id, message.message.ingestSeq)).toBe(
        true,
      )
      expect(yield* im.hasSubscriptionDelivery(message.message.id)).toBe(true)
      const duplicate = yield* im.ingest({ message: new NormalizedMessage({ ...message.message, text: "duplicate" }) })
      expect(duplicate.message.legacyStatus).toBe("completed")
    }),
  )
})
