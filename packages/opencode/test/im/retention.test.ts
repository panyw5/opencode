import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Exit, Layer, Schema } from "effect"
import { ConfigChannels } from "../../src/config/channels"
import { IMRetention, inboundFingerprint, outboundFingerprint } from "../../src/im/retention"
import { IM } from "../../src/im/service"
import { IMMessageTable, IMOutboundTable, IMSequenceTable } from "../../src/im/inbox.sql"
import { IMMessageTombstoneTable, IMOutboundTombstoneTable } from "../../src/im/retention.sql"
import { IMSubscriptionTable } from "../../src/im/subscription.sql"
import { IMSubscriptionDeliveryTable } from "../../src/im/subscription.sql"
import { SessionInputTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { Database, and, eq, sql } from "../../src/storage/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { InstanceState } from "../../src/effect/instance-state"
import { NormalizedMessage, Target } from "../../src/im/model"
import { registry, transportCapabilities } from "../../src/im/transport"
import type { IMTransport } from "../../src/im/model"

const migration = readFileSync(
  path.resolve(import.meta.dir, "../../migration/20260914103109_im_retention/migration.sql"),
  "utf8",
)

describe("IM retention", () => {
  afterEach(() => {
    Database.use((db) => {
      db.delete(IMSubscriptionDeliveryTable)
        .where(sql`subscription_id IN (SELECT id FROM im_subscription WHERE channel_name LIKE 'retention-%')`)
        .run()
      db.delete(SessionInputTable)
        .where(sql`id LIKE 'evt_im_ret%'`)
        .run()
      db.delete(IMSubscriptionTable)
        .where(sql`channel_name LIKE 'retention-%'`)
        .run()
      db.delete(IMMessageTable)
        .where(sql`channel_name LIKE 'retention-%'`)
        .run()
      db.delete(IMOutboundTable)
        .where(sql`channel_name LIKE 'retention-%'`)
        .run()
      db.delete(IMMessageTombstoneTable)
        .where(sql`channel_name LIKE 'retention-%'`)
        .run()
      db.delete(IMOutboundTombstoneTable)
        .where(sql`project_id LIKE 'project_retention_%'`)
        .run()
      db.delete(SessionTable)
        .where(sql`id LIKE 'ses_retention_%'`)
        .run()
      db.delete(ProjectTable)
        .where(sql`id LIKE 'project_retention_%'`)
        .run()
    })
  })
  test("uses strict optional retention configuration", () => {
    const decode = Schema.decodeUnknownSync(ConfigChannels.Info)
    expect((decode({ type: "qq", appId: "a", clientSecret: "s" }) as ConfigChannels.QQ).retentionDays).toBeUndefined()
    expect(
      (decode({ type: "qq", appId: "a", clientSecret: "s", retentionDays: 30 }) as ConfigChannels.QQ).retentionDays,
    ).toBe(30)
    expect(() => decode({ type: "qq", appId: "a", clientSecret: "s", retentionDays: 0 })).toThrow()
    expect(() => decode({ type: "qq", appId: "a", clientSecret: "s", retentionDays: 3651 })).toThrow()
  })

  test("creates hashed receipts without message body or private identity fields", () => {
    const db = new SQLite(":memory:")
    db.run(migration)
    const inbound = inboundFingerprint({
      platform: "qq",
      channelName: "c",
      eventID: "e",
      scope: "chat",
      conversationID: "private",
      senderID: "user",
      text: "secret",
    })
    const outbound = outboundFingerprint({
      platform: "qq",
      channelName: "c",
      mode: "reply",
      target: { scope: "chat", conversationID: "private", senderID: "user" },
      text: "secret",
    })
    db.run(
      "INSERT INTO im_message_tombstone (id,platform,channel_name,event_id,ingest_seq,payload_hash,legacy_status,time_created,time_updated) VALUES ('e','qq','c','e',7,?,'completed',1,1)",
      inbound,
    )
    db.run(
      "INSERT INTO im_outbound_tombstone (id,project_id,platform,channel_name,payload_hash,status,time_created,time_updated) VALUES ('o','p','qq','c',?,'sent',1,1)",
      outbound,
    )
    expect(
      db
        .query("PRAGMA table_info(im_message_tombstone)")
        .all()
        .map((row: any) => row.name),
    ).not.toContain("text")
    expect(
      db
        .query("PRAGMA table_info(im_message_tombstone)")
        .all()
        .map((row: any) => row.name),
    ).not.toContain("sender_id")
    expect(db.query("SELECT payload_hash FROM im_message_tombstone").get()).toEqual({ payload_hash: inbound })
    expect(db.query("SELECT payload_hash FROM im_outbound_tombstone").get()).toEqual({ payload_hash: outbound })
    db.close()
  })

  test("retention migration does not create or reset the ingest counter", () => {
    const db = new SQLite(":memory:")
    db.run("CREATE TABLE im_sequence (id text PRIMARY KEY, next_ingest_seq integer NOT NULL)")
    db.run("INSERT INTO im_sequence VALUES ('im_message', 42)")
    db.run(migration)
    expect(db.query("SELECT next_ingest_seq FROM im_sequence WHERE id='im_message'").get()).toEqual({
      next_ingest_seq: 42,
    })
    db.close()
  })

  const it = testEffect(Layer.mergeAll(IMRetention.defaultLayer))
  const imIt = testEffect(Layer.mergeAll(IM.defaultLayer, IMRetention.defaultLayer))

  it.instance(
    "cleans old messages while preserving pending owners and undelivered active subscriptions without ACL",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const instance = yield* InstanceState.context
        const retention = yield* IMRetention.Service
        const projectID = instance.project.id
        const old = 1
        const now = 10 * 86_400_000
        const channelName = `retention-${crypto.randomUUID()}`
        Database.use((db) =>
          db
            .insert(IMSequenceTable)
            .values({ id: "im_message", next_ingest_seq: 42 })
            .onConflictDoUpdate({ target: IMSequenceTable.id, set: { next_ingest_seq: 42 } })
            .run(),
        )
        const target = (conversationID: string) => ({
          platform: "feishu" as const,
          channelName,
          scope: "chat" as const,
          conversationID,
        })
        const rows = [
          { id: "drop", conversationID: "drop", seq: 1 },
          { id: "pending", conversationID: "pending", seq: 2 },
          { id: "promoted", conversationID: "promoted", seq: 3 },
          { id: "watched", conversationID: "watched", seq: 4 },
          { id: "sender-miss", conversationID: "sender-miss", seq: 5 },
          { id: "keyword-miss", conversationID: "keyword-miss", seq: 6 },
          { id: "revoked", conversationID: "revoked", seq: 7 },
          { id: "stopped", conversationID: "stopped", seq: 8 },
        ]
        const sessions = rows.slice(1, 4).map((row) => `ses_retention_${row.id}_${crypto.randomUUID()}`)
        Database.use((db) => {
          for (const [index, sessionID] of sessions.entries()) {
            db.insert(SessionTable)
              .values({
                id: sessionID,
                project_id: projectID,
                slug: `retention-${index}`,
                directory,
                title: `Retention ${index}`,
                version: "test",
                time_created: now,
                time_updated: now,
              })
              .run()
          }
          for (const row of rows) {
            db.insert(IMMessageTable)
              .values({
                id: `ret_${row.id}`,
                platform: "feishu",
                channel_name: channelName,
                event_id: `event-${row.id}`,
                ingest_seq: row.seq,
                direction: "inbound",
                legacy_status: "completed",
                scope: "chat",
                conversation_id: row.conversationID,
                sender_id: row.id === "sender-miss" ? "other" : "sender",
                text: row.id === "keyword-miss" ? "ordinary" : "urgent message",
                time_created: old,
                time_updated: old,
              })
              .run()
          }
          db.insert(IMSubscriptionTable)
            .values({
              id: `sub-watched-${crypto.randomUUID()}`,
              project_id: projectID,
              session_id: sessions[2]!,
              platform: "feishu",
              channel_name: channelName,
              scope: "chat",
              conversation_id: "watched",
              status: "active",
              start_seq: -1,
              delivery_cursor: -1,
              time_created: old,
              time_updated: old,
            })
            .run()
          db.insert(IMSubscriptionTable)
            .values({
              id: `sub-sender-${crypto.randomUUID()}`,
              project_id: projectID,
              session_id: sessions[0]!,
              platform: "feishu",
              channel_name: channelName,
              scope: "chat",
              conversation_id: "sender-miss",
              sender_id: "expected",
              status: "active",
              start_seq: -1,
              delivery_cursor: -1,
              time_created: old,
              time_updated: old,
            })
            .run()
          db.insert(IMSubscriptionTable)
            .values({
              id: `sub-keyword-${crypto.randomUUID()}`,
              project_id: projectID,
              session_id: sessions[0]!,
              platform: "feishu",
              channel_name: channelName,
              scope: "chat",
              conversation_id: "keyword-miss",
              keyword: "urgent",
              status: "active",
              start_seq: -1,
              delivery_cursor: -1,
              time_created: old,
              time_updated: old,
            })
            .run()
          db.insert(IMSubscriptionTable)
            .values({
              id: `sub-revoked-${crypto.randomUUID()}`,
              project_id: projectID,
              session_id: sessions[0]!,
              platform: "feishu",
              channel_name: channelName,
              scope: "chat",
              conversation_id: "revoked",
              status: "active",
              start_seq: -1,
              delivery_cursor: -1,
              time_created: old,
              time_updated: old,
            })
            .run()
          db.insert(IMSubscriptionTable)
            .values({
              id: `sub-stopped-${crypto.randomUUID()}`,
              project_id: projectID,
              session_id: sessions[0]!,
              platform: "feishu",
              channel_name: channelName,
              scope: "chat",
              conversation_id: "stopped",
              status: "stopped",
              start_seq: -1,
              delivery_cursor: -1,
              time_created: old,
              time_updated: old,
            })
            .run()
          db.insert(SessionInputTable)
            .values({
              id: `evt_im_ret_pending_${rows[1]!.id}_${sessions[0]}` as never,
              session_id: sessions[0]!,
              prompt: { text: "pending", metadata: {} },
              delivery: "deferred",
              admitted_seq: 1,
              promoted_seq: null,
              time_created: old,
            })
            .run()
          db.insert(SessionInputTable)
            .values({
              id: `evt_im_ret_promoted_${sessions[1]}` as never,
              session_id: sessions[1]!,
              prompt: { text: "promoted", metadata: {} },
              delivery: "deferred",
              admitted_seq: 1,
              promoted_seq: 1,
              time_created: old,
            })
            .run()
        })
        const result = yield* retention.cleanup([{ channelName, retentionDays: 1 }], now)
        expect(result.inbound).toBe(4)
        expect(
          Database.use((db) =>
            db
              .select({ id: IMMessageTable.id })
              .from(IMMessageTable)
              .where(eq(IMMessageTable.channel_name, channelName))
              .all(),
          )
            .map((row) => row.id)
            .toSorted(),
        ).toEqual(["ret_pending", "ret_promoted", "ret_revoked", "ret_watched"])
        expect(
          Database.use((db) =>
            db.select({ id: IMMessageTable.id }).from(IMMessageTable).where(eq(IMMessageTable.id, "ret_watched")).all(),
          ),
        ).toHaveLength(1)
        expect(yield* retention.inboundReceipt("ret_drop", "event-drop", channelName, "feishu")).toMatchObject({
          id: "ret_drop",
        })
        expect(
          Database.use((db) =>
            db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, sessions[0]!)).all(),
          ),
        ).toHaveLength(1)
        expect(
          Database.use((db) =>
            db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, sessions[1]!)).all(),
          ),
        ).toHaveLength(1)
        expect(
          Database.use((db) => db.select().from(IMSequenceTable).where(eq(IMSequenceTable.id, "im_message")).get()),
        ).toMatchObject({ next_ingest_seq: 42 })
        Database.use((db) => {
          db.insert(IMMessageTombstoneTable)
            .values({
              id: "receipt-qq",
              platform: "qq",
              channel_name: "receipt-a",
              event_id: "shared-event",
              ingest_seq: 1,
              payload_hash: "hash-a",
              legacy_status: "completed",
              time_created: old,
              time_updated: now,
            })
            .run()
          db.insert(IMMessageTombstoneTable)
            .values({
              id: "receipt-feishu",
              platform: "feishu",
              channel_name: "receipt-b",
              event_id: "shared-event",
              ingest_seq: 2,
              payload_hash: "hash-b",
              legacy_status: "completed",
              time_created: old,
              time_updated: now,
            })
            .run()
        })
        expect(yield* retention.inboundReceipt("missing", "shared-event", "receipt-a", "qq")).toMatchObject({
          id: "receipt-qq",
        })
        expect(yield* retention.inboundReceipt("missing", "shared-event", "receipt-b", "feishu")).toMatchObject({
          id: "receipt-feishu",
        })
      }),
  )

  it.instance("cleans 202 old outbound rows across project and id keyset boundaries", () =>
    Effect.gen(function* () {
      const instance = yield* InstanceState.context
      const retention = yield* IMRetention.Service
      const projectA = instance.project.id
      const projectB = `project_retention_${crypto.randomUUID()}` as never
      const channelName = `retention-outbound-${crypto.randomUUID()}`
      const old = 1
      const now = 10 * 86_400_000
      Database.use((db) => {
        db.insert(ProjectTable)
          .values({ id: projectB, worktree: "/tmp/retention-b", time_created: old, time_updated: old, sandboxes: [] })
          .run()
        for (let index = 0; index < 101; index++) {
          for (const projectID of [projectA, projectB]) {
            db.insert(IMOutboundTable)
              .values({
                id: `shared-${index}`,
                project_id: projectID,
                platform: "qq",
                channel_name: channelName,
                mode: "proactive",
                target: { platform: "qq", channelName, scope: "c2c", conversationID: "private:user" },
                provider_sequence_key: "qq\0sequence",
                provider_sequence: index + 1,
                text: "secret",
                status: "sent",
                attempt_count: 1,
                time_created: old,
                time_updated: old,
              })
              .run()
          }
        }
        for (const status of ["pending", "unknown"] as const) {
          db.insert(IMOutboundTable)
            .values({
              id: `keep-${status}`,
              project_id: projectA,
              platform: "qq",
              channel_name: channelName,
              mode: "proactive",
              target: { platform: "qq", channelName, scope: "c2c", conversationID: "private:user" },
              text: "secret",
              status,
              attempt_count: 1,
              time_created: old,
              time_updated: old,
            })
            .run()
        }
      })
      const result = yield* retention.cleanup([{ channelName, retentionDays: 1 }], now)
      expect(result.outbound).toBe(202)
      expect(
        Database.use((db) =>
          db.select().from(IMOutboundTable).where(eq(IMOutboundTable.channel_name, channelName)).all(),
        )
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(["keep-pending", "keep-unknown"])
      expect(yield* retention.outboundReceipt(projectA, "shared-100")).toMatchObject({
        project_id: projectA,
        id: "shared-100",
      })
      expect(yield* retention.outboundReceipt(projectB, "shared-100")).toMatchObject({
        project_id: projectB,
        id: "shared-100",
      })
    }),
  )

  it.effect("does not delete without policy and rejects invalid retention days", () =>
    Effect.gen(function* () {
      const retention = yield* IMRetention.Service
      expect(yield* retention.cleanup([])).toEqual({ inbound: 0, outbound: 0 })
      expect(yield* retention.cleanup([{ channelName: "none", retentionDays: 0 }]).pipe(Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
      expect(yield* retention.cleanup([{ channelName: "none", retentionDays: 3651 }]).pipe(Effect.exit)).toMatchObject({
        _tag: "Failure",
      })
    }).pipe(Effect.provide(IMRetention.defaultLayer)),
  )

  imIt.instance("keeps post-cleanup idempotency and after checkpoints correct", () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      const instance = yield* InstanceState.context
      const im = yield* IM.Service
      const retention = yield* IMRetention.Service
      const channelName = `retention-replay-${crypto.randomUUID()}`
      const target = new Target({ platform: "feishu", channelName, scope: "chat", conversationID: "chat-1" })
      const old = 1
      const now = 10 * 86_400_000
      const first = yield* im.ingest({
        message: new NormalizedMessage({
          id: `im_${crypto.randomUUID()}`,
          platform: "feishu",
          channelName,
          eventID: "same-event",
          target,
          text: "expired body",
        }),
      })
      yield* im.markLegacyStatus(first.message.id, "processing")
      yield* im.markLegacyCompleted(first.message.id)
      Database.use((db) =>
        db.update(IMMessageTable).set({ time_created: old }).where(eq(IMMessageTable.id, first.message.id)).run(),
      )
      const beforeCounter = Database.use((db) =>
        db
          .select({ next: IMSequenceTable.next_ingest_seq })
          .from(IMSequenceTable)
          .where(eq(IMSequenceTable.id, "im_message"))
          .get(),
      )
      const before = yield* im.list({
        projectID: instance.project.id,
        channelName,
        conversationID: target.conversationID,
        direction: "after",
      })
      expect((yield* retention.cleanup([{ channelName, retentionDays: 1 }], now)).inbound).toBe(1)
      const replay = yield* im.ingest({ message: new NormalizedMessage({ ...first.message, text: "changed" }) })
      expect(replay).toMatchObject({ inserted: false, expired: true, message: { text: "" } })
      expect(
        Database.use((db) =>
          db
            .select({ next: IMSequenceTable.next_ingest_seq })
            .from(IMSequenceTable)
            .where(eq(IMSequenceTable.id, "im_message"))
            .get(),
        ),
      ).toEqual(beforeCounter)
      const otherChannel = `${channelName}-other`
      const otherTarget = new Target({ ...target, channelName: otherChannel })
      expect(
        (yield* im.ingest({
          message: new NormalizedMessage({
            id: `im_${crypto.randomUUID()}`,
            platform: "feishu",
            channelName: otherChannel,
            eventID: "same-event",
            target: otherTarget,
            text: "other channel",
          }),
        })).inserted,
      ).toBe(true)
      const fresh = yield* im.ingest({
        message: new NormalizedMessage({
          id: `im_${crypto.randomUUID()}`,
          platform: "feishu",
          channelName,
          eventID: "new-event",
          target,
          text: "fresh",
        }),
      })
      const after = yield* im.list({
        projectID: instance.project.id,
        channelName,
        conversationID: target.conversationID,
        direction: "after",
        cursor: before.checkpoint,
      })
      expect(after.items.map((item) => item.id)).toContain(fresh.message.id)

      let sends = 0
      const transport: IMTransport = {
        platform: "feishu",
        channelName,
        capabilities: transportCapabilities("feishu"),
        sendText: async () => {
          sends++
          return { providerMessageID: "provider-old", timeSent: Date.now() }
        },
      }
      registry.register(transport)
      try {
        const input = {
          id: `out-${crypto.randomUUID()}`,
          projectID: instance.project.id,
          channelName,
          platform: "feishu" as const,
          mode: "proactive" as const,
          target,
          text: "outbound",
        }
        yield* im.sendText(input)
        Database.use((db) =>
          db
            .update(IMOutboundTable)
            .set({ time_created: old })
            .where(and(eq(IMOutboundTable.project_id, input.projectID), eq(IMOutboundTable.id, input.id)))
            .run(),
        )
        expect((yield* retention.cleanup([{ channelName, retentionDays: 1 }], now)).outbound).toBe(1)
        expect(yield* im.sendText(input)).toMatchObject({ status: "sent", providerMessageID: "provider-old" })
        expect(sends).toBe(1)
        expect(Exit.isFailure(yield* im.sendText({ ...input, text: "different" }).pipe(Effect.exit))).toBe(true)
        const replayWithoutACL = yield* im.sendText(input)
        expect(replayWithoutACL.status).toBe("sent")
        expect(replayWithoutACL.providerMessageID).toBe("provider-old")
      } finally {
        registry.unregister(channelName, transport)
      }
      expect(directory).toBeTruthy()
    }),
  )
})
