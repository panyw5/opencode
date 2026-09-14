import { expect } from "bun:test"
import { Clock, Deferred, Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { IM, SEND_LEASE_MS } from "../../src/im/service"
import { IMOutboundTable } from "../../src/im/inbox.sql"
import { Target } from "../../src/im/model"
import { registry, transportCapabilities } from "../../src/im/transport"
import { ProjectID } from "../../src/project/schema"
import { ProjectTable } from "../../src/project/project.sql"
import { Database, eq } from "../../src/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(IM.defaultLayer)
it.effect("another runtime preserves live sends and recovers only expired leases", () =>
  Effect.gen(function* () {
    const service = yield* IM.Service
    const projectID = ProjectID.ascending()
    const channelName = `lease-${crypto.randomUUID()}`
    const target = new Target({ platform: "feishu", channelName, scope: "chat", conversationID: "chat" })
    Database.use((db) =>
      db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: "/tmp", sandboxes: [], time_created: Date.now(), time_updated: Date.now() })
        .run(),
    )
    const started = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    registry.register({
      platform: "feishu",
      channelName,
      capabilities: transportCapabilities("feishu"),
      sendText: async () => {
        await Effect.runPromise(Deferred.succeed(started, undefined))
        await Effect.runPromise(Deferred.await(finish))
        return { providerMessageID: "lease-provider", timeSent: Date.now() }
      },
    })
    try {
      const sending = yield* Effect.forkScoped(
        service.sendText({
          projectID,
          id: "live",
          platform: "feishu",
          channelName,
          target,
          mode: "proactive",
          text: "live send",
        }),
      )
      yield* Deferred.await(started)
      yield* Effect.gen(function* () {
        const other = yield* IM.Service
        yield* other.recoverPendingSends()
      }).pipe(Effect.provide(IM.layer))
      const row = () =>
        Database.use((db) => db.select().from(IMOutboundTable).where(eq(IMOutboundTable.project_id, projectID)).get())!
      expect(row().status).toBe("pending")
      yield* TestClock.adjust("120 seconds")
      expect(row().status).toBe("pending")
      expect(row().lease_expires_at!).toBeGreaterThan(SEND_LEASE_MS)
      yield* Deferred.succeed(finish, undefined)
      expect((yield* Fiber.join(sending)).status).toBe("sent")
      expect(row().lease_expires_at).toBeNull()
      const now = yield* Clock.currentTimeMillis
      for (const [id, lease, updated] of [
        ["expired", now - 1, now],
        ["legacy-expired", null, now - SEND_LEASE_MS - 1],
        ["foreign-live", now + SEND_LEASE_MS, now],
        ["legacy-fresh", null, now],
      ] as const) {
        Database.use((db) =>
          db
            .insert(IMOutboundTable)
            .values({
              id,
              project_id: projectID,
              platform: "feishu",
              channel_name: channelName,
              mode: "proactive",
              target,
              text: id,
              status: "pending",
              attempt_count: 1,
              lease_expires_at: lease,
              time_created: updated,
              time_updated: updated,
            })
            .run(),
        )
      }
      yield* service.recoverPendingSends()
      const states = Object.fromEntries(
        Database.use((db) =>
          db.select().from(IMOutboundTable).where(eq(IMOutboundTable.project_id, projectID)).all(),
        ).map((r) => [r.id, r.status]),
      )
      expect(states).toMatchObject({
        expired: "unknown",
        "legacy-expired": "pending",
        "foreign-live": "pending",
        "legacy-fresh": "pending",
      })
    } finally {
      registry.unregister(channelName)
      Database.use((db) => db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run())
    }
  }),
)
