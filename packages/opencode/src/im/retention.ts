import { createHash } from "node:crypto"
import { and, asc, eq, gt, lt, or, sql } from "@/storage/db"
import { Database } from "@/storage/db"
import { Context, Effect, Layer } from "effect"
import { IMMessageTable, IMOutboundTable } from "./inbox.sql"
import { IMSubscriptionDeliveryTable, IMSubscriptionTable } from "./subscription.sql"
import { IMMessageTombstoneTable, IMOutboundTombstoneTable } from "./retention.sql"
import { SessionInputTable } from "@/session/session.sql"
import type { IMModel } from "./model"
import type { ProjectID } from "@/project/schema"
import { makeRuntime } from "@/effect/run-service"

export type RetentionPolicy = { channelName: string; retentionDays: number }
export type InboundFingerprint = {
  platform: IMModel.Platform
  channelName: string
  eventID: string
  scope?: string
  conversationID?: string
  senderID?: string
  text?: string
}
export type OutboundFingerprint = {
  format?: IMModel.MessageFormat
  platform: IMModel.Platform
  channelName: string
  mode: string
  target: {
    scope?: string
    conversationID?: string
    senderID?: string
    replyTo?: string
    platform?: string
    channelName?: string
  }
  text: string
}
export type InboundReceipt = typeof IMMessageTombstoneTable.$inferSelect
export type OutboundReceipt = typeof IMOutboundTombstoneTable.$inferSelect

const BATCH = 100

function canonical(value: Record<string, unknown>) {
  return JSON.stringify(value, Object.keys(value).sort())
}

export function inboundFingerprint(input: InboundFingerprint) {
  return createHash("sha256").update(canonical(input)).digest("hex")
}

export function outboundFingerprint(input: OutboundFingerprint) {
  return createHash("sha256")
    .update(
      canonical({
        platform: input.platform,
        channelName: input.channelName,
        mode: input.mode,
        scope: input.target.scope,
        conversationID: input.target.conversationID,
        senderID: input.target.senderID,
        replyTo: input.target.replyTo,
        text: input.text,
        ...(input.format && input.format !== "text" ? { format: input.format } : {}),
      }),
    )
    .digest("hex")
}

export interface Interface {
  readonly inboundReceipt: (
    id: string,
    eventID?: string,
    channelName?: string,
    platform?: IMModel.Platform,
  ) => Effect.Effect<InboundReceipt | undefined>
  readonly outboundReceipt: (projectID: ProjectID, id: string) => Effect.Effect<OutboundReceipt | undefined>
  readonly cleanup: (
    policies: readonly RetentionPolicy[],
    now?: number,
  ) => Effect.Effect<{ inbound: number; outbound: number }, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/IMRetention") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const inboundReceipt = Effect.fn("IMRetention.inboundReceipt")(function* (
      id: string,
      eventID?: string,
      channelName?: string,
      platform?: IMModel.Platform,
    ) {
      return Database.use((db) =>
        db
          .select()
          .from(IMMessageTombstoneTable)
          .where(
            and(
              eventID
                ? or(eq(IMMessageTombstoneTable.id, id), eq(IMMessageTombstoneTable.event_id, eventID))
                : eq(IMMessageTombstoneTable.id, id),
              ...(channelName ? [eq(IMMessageTombstoneTable.channel_name, channelName)] : []),
              ...(platform ? [eq(IMMessageTombstoneTable.platform, platform)] : []),
            ),
          )
          .get(),
      )
    })
    const outboundReceipt = Effect.fn("IMRetention.outboundReceipt")(function* (projectID: ProjectID, id: string) {
      return Database.use((db) =>
        db
          .select()
          .from(IMOutboundTombstoneTable)
          .where(and(eq(IMOutboundTombstoneTable.project_id, projectID), eq(IMOutboundTombstoneTable.id, id)))
          .get(),
      )
    })
    const cleanup = Effect.fn("IMRetention.cleanup")(function* (
      policies: readonly RetentionPolicy[],
      now = Date.now(),
    ) {
      let inbound = 0
      let outbound = 0
      for (const policy of policies) {
        if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1 || policy.retentionDays > 3650) {
          yield* Effect.die(new Error(`Invalid retentionDays for ${policy.channelName}`))
        }
        const cutoff = now - policy.retentionDays * 86_400_000
        let cursor = -1
        while (true) {
          const rows = Database.use((db) =>
            db
              .select()
              .from(IMMessageTable)
              .where(
                and(
                  eq(IMMessageTable.channel_name, policy.channelName),
                  lt(IMMessageTable.time_created, cutoff),
                  gt(IMMessageTable.ingest_seq, cursor),
                  eq(IMMessageTable.direction, "inbound"),
                  eq(IMMessageTable.legacy_status, "completed"),
                ),
              )
              .orderBy(asc(IMMessageTable.ingest_seq))
              .limit(BATCH)
              .all(),
          )
          if (!rows.length) break
          cursor = rows.at(-1)!.ingest_seq
          for (const row of rows) {
            const protectedByOwner = Database.use((db) =>
              db
                .select({ id: SessionInputTable.id })
                .from(SessionInputTable)
                .where(
                  and(
                    sql`${SessionInputTable.id} GLOB ${`evt_im_${row.id}_*`}`,
                    eq(SessionInputTable.delivery, "deferred"),
                  ),
                )
                .get(),
            )
            const targets = Database.use((db) =>
              db
                .select()
                .from(IMSubscriptionTable)
                .where(
                  and(
                    eq(IMSubscriptionTable.platform, row.platform),
                    eq(IMSubscriptionTable.channel_name, row.channel_name),
                    eq(IMSubscriptionTable.scope, row.scope),
                    eq(IMSubscriptionTable.conversation_id, row.conversation_id),
                    eq(IMSubscriptionTable.status, "active"),
                  ),
                )
                .all(),
            )
            const activeUndelivered = targets.some(
              (target) =>
                row.ingest_seq > target.start_seq &&
                (!target.sender_id || target.sender_id === row.sender_id) &&
                (!target.keyword || row.text.includes(target.keyword)) &&
                !Database.use((db) =>
                  db
                    .select({ id: IMSubscriptionDeliveryTable.message_id })
                    .from(IMSubscriptionDeliveryTable)
                    .where(
                      and(
                        eq(IMSubscriptionDeliveryTable.subscription_id, target.id),
                        eq(IMSubscriptionDeliveryTable.message_id, row.id),
                      ),
                    )
                    .get(),
                ),
            )
            if (protectedByOwner || activeUndelivered) continue
            Database.transaction(
              (db) => {
                db.insert(IMMessageTombstoneTable)
                  .values({
                    id: row.id,
                    platform: row.platform,
                    channel_name: row.channel_name,
                    event_id: row.event_id,
                    ingest_seq: row.ingest_seq,
                    payload_hash: inboundFingerprint({
                      platform: row.platform,
                      channelName: row.channel_name,
                      eventID: row.event_id,
                      scope: row.scope,
                      conversationID: row.conversation_id,
                      senderID: row.sender_id ?? undefined,
                      text: row.text,
                    }),
                    legacy_status: row.legacy_status,
                    time_created: row.time_created,
                    time_updated: now,
                  })
                  .onConflictDoNothing()
                  .run()
                db.delete(IMMessageTable).where(eq(IMMessageTable.id, row.id)).run()
              },
              { behavior: "immediate" },
            )
            inbound++
          }
          yield* Effect.yieldNow
        }
        let outboundCursor = 0
        let outboundProject = ""
        let outboundCursorID = ""
        while (true) {
          const rows = Database.use((db) =>
            db
              .select()
              .from(IMOutboundTable)
              .where(
                and(
                  eq(IMOutboundTable.channel_name, policy.channelName),
                  lt(IMOutboundTable.time_created, cutoff),
                  or(
                    gt(IMOutboundTable.time_created, outboundCursor),
                    and(
                      eq(IMOutboundTable.time_created, outboundCursor),
                      or(
                        gt(IMOutboundTable.project_id, outboundProject as ProjectID),
                        and(
                          eq(IMOutboundTable.project_id, outboundProject as ProjectID),
                          gt(IMOutboundTable.id, outboundCursorID),
                        ),
                      ),
                    ),
                  ),
                  or(eq(IMOutboundTable.status, "sent"), eq(IMOutboundTable.status, "failed")),
                ),
              )
              .orderBy(asc(IMOutboundTable.time_created), asc(IMOutboundTable.project_id), asc(IMOutboundTable.id))
              .limit(BATCH)
              .all(),
          )
          if (!rows.length) break
          outboundCursor = rows.at(-1)!.time_created
          outboundProject = rows.at(-1)!.project_id
          outboundCursorID = rows.at(-1)!.id
          for (const row of rows)
            Database.transaction(
              (db) => {
                db.insert(IMOutboundTombstoneTable)
                  .values({
                    id: row.id,
                    project_id: row.project_id,
                    platform: row.platform,
                    channel_name: row.channel_name,
                    payload_hash: outboundFingerprint({
                      platform: row.platform,
                      channelName: row.channel_name,
                      mode: row.mode,
                      target: row.target,
                      text: row.text,
                      format: row.format,
                    }),
                    status: row.status,
                    provider_message_id: row.provider_message_id,
                    time_created: row.time_created,
                    time_updated: now,
                  })
                  .onConflictDoNothing()
                  .run()
                db.delete(IMOutboundTable)
                  .where(and(eq(IMOutboundTable.id, row.id), eq(IMOutboundTable.project_id, row.project_id)))
                  .run()
              },
              { behavior: "immediate" },
            )
          outbound += rows.length
          yield* Effect.yieldNow
        }
      }
      return { inbound, outbound }
    })
    return { inboundReceipt, outboundReceipt, cleanup }
  }),
)

export const defaultLayer = layer
export const runtime = makeRuntime(Service, defaultLayer)
export * as IMRetention from "./retention"
