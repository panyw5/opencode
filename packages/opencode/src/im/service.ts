import { and, asc, desc, eq, gt, lt, or, sql } from "@/storage/db"
import { Database } from "@/storage/db"
import { Effect, Context, Layer, Exit, Schema, Cause, Clock } from "effect"
import type { SQL } from "drizzle-orm"
import { createHash } from "node:crypto"
import {
  IMMessageTable,
  IMAttachmentTable,
  IMOutboundTable,
  IMSequenceTable,
  type IMLegacyStatus,
  type IMOutboundStatus,
} from "./inbox.sql"
import { IMSubscriptionDeliveryTable } from "./subscription.sql"
import { IMMessageTombstoneTable, IMOutboundTombstoneTable } from "./retention.sql"
import { inboundFingerprint, outboundFingerprint } from "./retention"
import {
  NormalizedMessage,
  Target,
  isTargetScopeSupported,
  proactiveCapability,
  type IMModel,
  type IMTransport,
  type SendMode,
  type TransportSendResult,
  type MessageFormat,
  TEXT_LIMIT,
  MARKDOWN_LIMIT,
  type Attachment,
} from "./model"
import { ProviderRejectedError, SendValidationError, registry } from "./transport"
import * as Log from "@opencode-ai/core/util/log"
import { makeRuntime } from "@/effect/run-service"
import type { ProjectID } from "@/project/schema"

const log = Log.create({ service: "im.service" })
const MAX_PAGE_SIZE = 100
export const SEND_LEASE_MS = 60_000
const LEASE_TICK_MS = 10_000

export type MessageInfo = {
  id: string
  platform: IMModel.Platform
  channelName: string
  eventID: string
  ingestSeq: number
  direction: "inbound" | "outbound"
  legacyStatus: IMLegacyStatus
  target: Target
  senderID?: string
  senderName?: string
  text: string
  timeEvent?: number
  timeCreated: number
  metadata?: Record<string, unknown>
  attachments?: Attachment[]
}

export type MessagePage = { items: MessageInfo[]; nextCursor?: string; checkpoint?: string }
export type IngestResult = { message: MessageInfo; inserted: boolean; expired?: boolean }
export type OutboundInfo = {
  format: MessageFormat
  id: string
  projectID: ProjectID
  platform: IMModel.Platform
  channelName: string
  mode: SendMode
  target: Target
  text: string
  status: IMOutboundStatus
  providerMessageID?: string
  providerSequence?: number
  attemptCount: number
  lastError?: string
  timeCreated: number
  timeUpdated: number
}

export type IngestInput = {
  message: NormalizedMessage
}

export type ListInput = {
  projectID: ProjectID
  channelName?: string
  conversationID?: string
  senderID?: string
  limit?: number
  cursor?: string
  direction?: "before" | "after"
  waitMs?: number
}

export type SendInput = {
  format?: MessageFormat
  id: string
  projectID: ProjectID
  channelName: string
  platform: IMModel.Platform
  mode: SendMode
  target: Target
  text: string
}

export interface Interface {
  readonly ingest: (input: IngestInput) => Effect.Effect<IngestResult>
  readonly list: (input: ListInput) => Effect.Effect<MessagePage, InvalidCursorError>
  readonly recoverPendingSends: () => Effect.Effect<number>
  readonly sendText: (
    input: SendInput,
  ) => Effect.Effect<
    OutboundInfo,
    OutboundConflictError | TargetMismatchError | InvalidReplyError | ProviderSequenceExhaustedError
  >
  readonly markLegacyStatus: (messageID: string, status: IMLegacyStatus) => Effect.Effect<boolean>
  readonly markLegacyCompleted: (messageID: string) => Effect.Effect<boolean>
  readonly claimLegacyProcessing: (messageID: string) => Effect.Effect<boolean>
  readonly hasSubscriptionDelivery: (messageID: string) => Effect.Effect<boolean>
  readonly reserveProviderSequence: (input: {
    platform: IMModel.Platform
    channelName: string
    target: Target
    mode: SendMode
  }) => Effect.Effect<number | undefined, ProviderSequenceExhaustedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/IM") {}

export class InvalidCursorError extends Schema.TaggedErrorClass<InvalidCursorError>()("IM.InvalidCursorError", {
  cursor: Schema.String,
}) {
  override get message() {
    return "Invalid IM message cursor"
  }
}

export class OutboundConflictError extends Schema.TaggedErrorClass<OutboundConflictError>()(
  "IM.OutboundConflictError",
  {
    outboundID: Schema.String,
  },
) {
  override get message() {
    return `Outbound idempotency key ${this.outboundID} was reused with a different payload`
  }
}

export class TargetMismatchError extends Schema.TaggedErrorClass<TargetMismatchError>()("IM.TargetMismatchError", {
  channelName: Schema.String,
}) {
  override get message() {
    return `IM target does not belong to channel ${this.channelName}`
  }
}

export class InvalidReplyError extends Schema.TaggedErrorClass<InvalidReplyError>()("IM.InvalidReplyError", {
  channelName: Schema.String,
}) {
  override get message() {
    return `IM reply target is not a valid inbound message for channel ${this.channelName}`
  }
}

export class ProviderSequenceExhaustedError extends Schema.TaggedErrorClass<ProviderSequenceExhaustedError>()(
  "IM.ProviderSequenceExhaustedError",
  { channelName: Schema.String },
) {}

type MessageRow = typeof IMMessageTable.$inferSelect
type OutboundRow = typeof IMOutboundTable.$inferSelect

function encodeCursor(value: { ingestSeq: number; direction: "before" | "after" }) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function decodeCursor(value: string | undefined): { ingestSeq: number; direction: "before" | "after" } | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>
    if (typeof parsed.ingestSeq !== "number" || (parsed.direction !== "before" && parsed.direction !== "after"))
      return undefined
    return { ingestSeq: parsed.ingestSeq, direction: parsed.direction }
  } catch {
    return undefined
  }
}

function targetFromMessage(row: MessageRow): Target {
  return new Target({
    platform: row.platform,
    channelName: row.channel_name,
    scope: row.scope,
    conversationID: row.conversation_id,
    ...(row.sender_id ? { senderID: row.sender_id } : {}),
    ...(row.reply_to ? { replyTo: row.reply_to } : {}),
  })
}

function attachmentsFor(messageID: string, includeData: boolean): Attachment[] {
  const fields = {
    id: IMAttachmentTable.id,
    kind: IMAttachmentTable.kind,
    mime: IMAttachmentTable.mime,
    filename: IMAttachmentTable.filename,
    size: IMAttachmentTable.size,
    sha256: IMAttachmentTable.sha256,
    status: IMAttachmentTable.status,
    reason: IMAttachmentTable.reason,
  }
  const rows = Database.use((db) =>
    includeData
      ? db
          .select()
          .from(IMAttachmentTable)
          .where(eq(IMAttachmentTable.message_id, messageID))
          .orderBy(asc(IMAttachmentTable.ordinal))
          .all()
      : db
          .select(fields)
          .from(IMAttachmentTable)
          .where(eq(IMAttachmentTable.message_id, messageID))
          .orderBy(asc(IMAttachmentTable.ordinal))
          .all(),
  )
  return rows.map(
    (item): Attachment => ({
      id: item.id,
      kind: item.kind,
      mime: item.mime,
      ...(item.filename ? { filename: item.filename } : {}),
      size: item.size,
      ...(item.sha256 ? { sha256: item.sha256 } : {}),
      status: item.status,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(includeData && "data" in item && item.data instanceof Uint8Array ? { data: new Uint8Array(item.data) } : {}),
    }),
  )
}

function fromMessageRow(row: MessageRow, includeData = true): MessageInfo {
  const attachments = attachmentsFor(row.id, includeData)
  return {
    id: row.id,
    platform: row.platform,
    channelName: row.channel_name,
    eventID: row.event_id,
    ingestSeq: row.ingest_seq,
    direction: row.direction,
    legacyStatus: row.legacy_status,
    target: targetFromMessage(row),
    senderID: row.sender_id ?? undefined,
    senderName: row.sender_name ?? undefined,
    text: row.text,
    timeEvent: row.time_event ?? undefined,
    timeCreated: row.time_created,
    metadata: row.metadata ?? undefined,
    ...(attachments.length ? { attachments } : {}),
  }
}

function targetValue(target: Target): IMModel.Target {
  return target
}

function providerSequenceKey(input: {
  platform: IMModel.Platform
  channelName: string
  target: Target
  mode: SendMode
}) {
  return [
    input.platform,
    input.channelName,
    input.target.scope,
    input.target.conversationID,
    input.mode === "reply" ? (input.target.replyTo ?? "") : "proactive",
  ].join("\0")
}

function allocateProviderSequence(
  db: any,
  input: {
    platform: IMModel.Platform
    channelName: string
    target: Target
    mode: SendMode
  },
) {
  if (input.platform !== "qq") return undefined
  const sequenceKey = providerSequenceKey(input)
  const counterID = `im_qq_sequence:${sequenceKey}`
  const counter = db.select().from(IMSequenceTable).where(eq(IMSequenceTable.id, counterID)).get()
  const persisted =
    db
      .select({ value: sql<number>`coalesce(max(${IMOutboundTable.provider_sequence}), 0)` })
      .from(IMOutboundTable)
      .where(eq(IMOutboundTable.provider_sequence_key, sequenceKey))
      .get()?.value ?? 0
  const next = Math.max(counter?.next_ingest_seq ?? 1, persisted + 1)
  if (next > 65535) return next
  if (counter)
    db.update(IMSequenceTable)
      .set({ next_ingest_seq: next + 1 })
      .where(eq(IMSequenceTable.id, counterID))
      .run()
  else
    db.insert(IMSequenceTable)
      .values({ id: counterID, next_ingest_seq: next + 1 })
      .run()
  return next
}

function fromOutboundRow(row: OutboundRow): OutboundInfo {
  return {
    id: row.id,
    projectID: row.project_id,
    platform: row.platform,
    channelName: row.channel_name,
    mode: row.mode,
    target: row.target,
    text: row.text,
    status: row.status,
    format: row.format,
    providerMessageID: row.provider_message_id ?? undefined,
    providerSequence: row.provider_sequence ?? undefined,
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? undefined,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

function updateOutbound(
  projectID: ProjectID,
  id: string,
  patch: {
    status: IMOutboundStatus
    providerMessageID?: string
    lastError?: string
  },
) {
  const row = Database.use((db) =>
    db
      .update(IMOutboundTable)
      .set({
        status: patch.status,
        provider_message_id: patch.providerMessageID,
        last_error: patch.lastError,
        lease_expires_at: null,
        time_updated: Date.now(),
      })
      .where(and(eq(IMOutboundTable.project_id, projectID), eq(IMOutboundTable.id, id)))
      .returning()
      .get(),
  )
  return row
}

function repairIngestSequences() {
  return Database.transaction(
    (db) => {
      const rows = db
        .select({ id: IMMessageTable.id, ingestSeq: IMMessageTable.ingest_seq })
        .from(IMMessageTable)
        .orderBy(asc(IMMessageTable.time_created), asc(IMMessageTable.id))
        .all()
      const unique = new Set(rows.map((row) => row.ingestSeq))
      if (unique.size === rows.length) return 0
      rows.forEach((row, index) => {
        db.update(IMMessageTable).set({ ingest_seq: index }).where(eq(IMMessageTable.id, row.id)).run()
      })
      return rows.length
    },
    { behavior: "immediate" },
  )
}

function ensureIngestCounter() {
  return Database.transaction(
    (db) => {
      const max =
        db
          .select({ value: sql<number>`coalesce(max(${IMMessageTable.ingest_seq}), -1)` })
          .from(IMMessageTable)
          .get()?.value ?? -1
      const existing = db.select().from(IMSequenceTable).where(eq(IMSequenceTable.id, "im_message")).get()
      const next = Math.max(existing?.next_ingest_seq ?? 0, max + 1)
      if (existing)
        db.update(IMSequenceTable).set({ next_ingest_seq: next }).where(eq(IMSequenceTable.id, "im_message")).run()
      else db.insert(IMSequenceTable).values({ id: "im_message", next_ingest_seq: next }).run()
      return next
    },
    { behavior: "immediate" },
  )
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const repaired = repairIngestSequences()
    if (repaired > 0) log.warn("repaired non-monotonic IM ingest sequence", { count: repaired })
    ensureIngestCounter()
    const recoverPendingSends = Effect.fn("IM.recoverPendingSends")(function* () {
      const now = yield* Clock.currentTimeMillis
      const recovered = Database.use(
        (db) =>
          db
            .update(IMOutboundTable)
            .set({
              status: "unknown",
              last_error: "Send lease expired; provider acceptance could not be confirmed",
              time_updated: Date.now(),
            })
            .where(and(eq(IMOutboundTable.status, "pending"), sql`${IMOutboundTable.lease_expires_at} <= ${now}`))
            .returning({ id: IMOutboundTable.id })
            .all().length,
      )
      if (recovered > 0) log.warn("recovered expired outbound sends as unknown", { count: recovered })
      return recovered
    })
    // Older app versions do not own a lease. Their pending sends may still be
    // live in another process, so do not guess their state from row age.
    const untracked = Database.use(
      (db) =>
        db
          .select({ count: sql<number>`count(*)` })
          .from(IMOutboundTable)
          .where(and(eq(IMOutboundTable.status, "pending"), sql`${IMOutboundTable.lease_expires_at} is null`))
          .get()?.count ?? 0,
    )
    if (untracked) log.warn("legacy pending sends retained without ownership evidence", { count: untracked })
    yield* recoverPendingSends()
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(LEASE_TICK_MS).pipe(
          Effect.andThen(recoverPendingSends()),
          Effect.catchCause((cause) => Effect.sync(() => log.error("IM lease recovery failed", { cause }))),
        ),
      ),
    )

    const ingest = Effect.fn("IM.ingest")(function* (input: IngestInput) {
      const message = input.message
      const now = Date.now()
      const expired = Database.use((db) =>
        db
          .select()
          .from(IMMessageTombstoneTable)
          .where(
            and(
              eq(IMMessageTombstoneTable.platform, message.platform),
              eq(IMMessageTombstoneTable.channel_name, message.channelName),
              eq(IMMessageTombstoneTable.event_id, message.eventID),
            ),
          )
          .get(),
      )
      if (expired) {
        log.info("inbound expired duplicate ignored", {
          platform: message.platform,
          channelName: message.channelName,
          eventID: message.eventID,
        })
        return {
          inserted: false,
          expired: true as const,
          message: {
            id: message.id,
            platform: message.platform,
            channelName: message.channelName,
            eventID: message.eventID,
            ingestSeq: expired.ingest_seq,
            direction: "inbound" as const,
            legacyStatus: "completed" as const,
            target: message.target,
            senderID: message.senderID,
            senderName: message.senderName,
            text: "",
            timeEvent: message.timeEvent,
            timeCreated: expired.time_created,
            metadata: {
              expired: true,
              payloadHash: inboundFingerprint({
                platform: message.platform,
                channelName: message.channelName,
                eventID: message.eventID,
                scope: message.target.scope,
                conversationID: message.target.conversationID,
                senderID: message.senderID,
                text: message.text,
              }),
            },
          },
        }
      }
      const result = Database.transaction(
        (db) => {
          const existing = db
            .select()
            .from(IMMessageTable)
            .where(
              or(
                eq(IMMessageTable.id, message.id),
                and(eq(IMMessageTable.channel_name, message.channelName), eq(IMMessageTable.event_id, message.eventID)),
              ),
            )
            .get()
          if (existing) return { row: existing, inserted: false }
          const counter = db.select().from(IMSequenceTable).where(eq(IMSequenceTable.id, "im_message")).get()
          const nextSeq = counter?.next_ingest_seq ?? 0
          if (counter)
            db.update(IMSequenceTable)
              .set({ next_ingest_seq: nextSeq + 1 })
              .where(eq(IMSequenceTable.id, "im_message"))
              .run()
          else db.insert(IMSequenceTable).values({ id: "im_message", next_ingest_seq: 1 }).run()
          const row = db
            .insert(IMMessageTable)
            .values({
              id: message.id,
              platform: message.platform,
              channel_name: message.channelName,
              event_id: message.eventID,
              ingest_seq: nextSeq,
              direction: "inbound",
              legacy_status: "received",
              scope: message.target.scope,
              conversation_id: message.target.conversationID,
              sender_id: message.senderID,
              sender_name: message.senderName,
              reply_to: message.target.replyTo,
              text: message.text,
              time_event: message.timeEvent,
              metadata: message.metadata,
              time_created: now,
              time_updated: now,
            })
            .returning()
            .get()
          for (const [ordinal, attachment] of (message.attachments ?? []).entries())
            db.insert(IMAttachmentTable)
              .values({
                id: attachment.id,
                message_id: row.id,
                ordinal,
                kind: attachment.kind,
                mime: attachment.mime,
                filename: attachment.filename,
                size: attachment.size,
                sha256: attachment.sha256,
                status: attachment.status,
                reason: attachment.reason,
                data: attachment.data ? Buffer.from(attachment.data) : undefined,
                time_created: now,
                time_updated: now,
              })
              .run()
          return { row, inserted: true }
        },
        { behavior: "immediate" },
      )
      log.info(result.inserted ? "inbound message persisted" : "inbound duplicate ignored", {
        platform: message.platform,
        channelName: message.channelName,
        eventID: message.eventID,
        messageID: message.id,
        inserted: result.inserted,
      })
      return { message: fromMessageRow(result.row), inserted: result.inserted }
    })

    const list: Interface["list"] = Effect.fn("IM.list")(function* (input: ListInput) {
      const waitMs = Math.min(10_000, Math.max(0, Math.floor(input.waitMs ?? 0)))
      if (waitMs > 0 && input.direction === "after") {
        const deadline = Date.now() + waitMs
        while (true) {
          const page = yield* list({ ...input, waitMs: 0 })
          if (page.items.length > 0 || Date.now() >= deadline) return page
          yield* Effect.sleep("250 millis")
        }
      }
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.limit ?? 50)))
      const cursor = decodeCursor(input.cursor)
      if (input.cursor && !cursor) yield* new InvalidCursorError({ cursor: input.cursor })
      const direction = input.direction ?? cursor?.direction ?? "before"
      if (cursor && cursor.direction !== direction) yield* new InvalidCursorError({ cursor: input.cursor! })
      const conditions: SQL[] = []
      if (input.channelName) conditions.push(eq(IMMessageTable.channel_name, input.channelName))
      if (input.conversationID) conditions.push(eq(IMMessageTable.conversation_id, input.conversationID))
      if (input.senderID) conditions.push(eq(IMMessageTable.sender_id, input.senderID))
      if (cursor) {
        conditions.push(
          direction === "after"
            ? gt(IMMessageTable.ingest_seq, cursor.ingestSeq)
            : lt(IMMessageTable.ingest_seq, cursor.ingestSeq),
        )
      }
      const rows = Database.use((db) =>
        db
          .select()
          .from(IMMessageTable)
          .where(conditions.length ? and(...conditions) : undefined)
          .orderBy(direction === "after" ? asc(IMMessageTable.ingest_seq) : desc(IMMessageTable.ingest_seq))
          .limit(limit + 1)
          .all(),
      )
      const pageRows = rows.slice(0, limit)
      const last = pageRows.at(-1)
      log.debug("inbound page queried", {
        channelName: input.channelName,
        conversationID: input.conversationID,
        count: pageRows.length,
        hasMore: rows.length > limit,
      })
      const checkpoint =
        direction === "after"
          ? last
            ? encodeCursor({ ingestSeq: last.ingest_seq, direction })
            : cursor
              ? input.cursor
              : encodeCursor({ ingestSeq: -1, direction })
          : undefined
      return {
        items: pageRows.map((row) => {
          const message = fromMessageRow(row, false)
          return {
            ...message,
            attachments: message.attachments?.map(({ data: _, ...attachment }) => attachment),
          }
        }),
        ...(rows.length > limit && last ? { nextCursor: encodeCursor({ ingestSeq: last.ingest_seq, direction }) } : {}),
        ...(checkpoint ? { checkpoint } : {}),
      }
    })

    const sendTextCore = Effect.fn("IM.sendTextCore")(function* (input: SendInput) {
      const format = input.format ?? "text"
      if (input.target.channelName !== input.channelName || input.target.platform !== input.platform) {
        yield* new TargetMismatchError({ channelName: input.channelName })
      }
      if (!isTargetScopeSupported(input.platform, input.target.scope))
        yield* new TargetMismatchError({ channelName: input.channelName })
      if (input.mode === "reply") {
        if (!input.target.replyTo) yield* new InvalidReplyError({ channelName: input.channelName })
        const reply = Database.use((db) =>
          db
            .select({ id: IMMessageTable.id })
            .from(IMMessageTable)
            .where(
              and(
                eq(IMMessageTable.platform, input.platform),
                eq(IMMessageTable.channel_name, input.channelName),
                eq(IMMessageTable.scope, input.target.scope),
                eq(IMMessageTable.conversation_id, input.target.conversationID),
                eq(IMMessageTable.direction, "inbound"),
                eq(IMMessageTable.event_id, input.target.replyTo!),
              ),
            )
            .get(),
        )
        if (!reply) yield* new InvalidReplyError({ channelName: input.channelName })
      }
      const existing = Database.use((db) =>
        db
          .select()
          .from(IMOutboundTable)
          .where(and(eq(IMOutboundTable.project_id, input.projectID), eq(IMOutboundTable.id, input.id)))
          .get(),
      )
      const receipt = Database.use((db) =>
        db
          .select()
          .from(IMOutboundTombstoneTable)
          .where(
            and(eq(IMOutboundTombstoneTable.project_id, input.projectID), eq(IMOutboundTombstoneTable.id, input.id)),
          )
          .get(),
      )
      if (receipt) {
        const hash = outboundFingerprint({
          platform: input.platform,
          channelName: input.channelName,
          mode: input.mode,
          target: input.target,
          text: input.text,
          format,
        })
        if (hash !== receipt.payload_hash) yield* new OutboundConflictError({ outboundID: input.id })
        return {
          id: input.id,
          projectID: input.projectID,
          platform: input.platform,
          channelName: input.channelName,
          mode: input.mode,
          target: input.target,
          text: input.text,
          status: receipt.status as IMOutboundStatus,
          format,
          ...(receipt.provider_message_id ? { providerMessageID: receipt.provider_message_id } : {}),
          attemptCount: 0,
          timeCreated: receipt.time_created,
          timeUpdated: receipt.time_updated,
        }
      }
      if (existing) {
        const samePayload =
          existing.project_id === input.projectID &&
          existing.platform === input.platform &&
          existing.channel_name === input.channelName &&
          existing.mode === input.mode &&
          existing.text === input.text &&
          existing.format === format &&
          JSON.stringify(existing.target) === JSON.stringify(input.target)
        if (!samePayload) yield* new OutboundConflictError({ outboundID: input.id })
        log.info("outbound idempotency hit", {
          channelName: input.channelName,
          outboundID: input.id,
          status: existing.status,
        })
        return fromOutboundRow(existing)
      }
      const limit = format === "markdown" ? MARKDOWN_LIMIT : TEXT_LIMIT
      const invalidText =
        format === "markdown" && input.platform !== "feishu"
          ? "Markdown is supported only by Feishu channels"
          : input.text.length > limit
            ? `IM ${format} exceeds ${limit} characters`
            : undefined
      const leaseExpiresAt = (yield* Clock.currentTimeMillis) + SEND_LEASE_MS
      const pendingResult = Database.transaction(
        (db) => {
          const raced = db
            .select()
            .from(IMOutboundTable)
            .where(and(eq(IMOutboundTable.project_id, input.projectID), eq(IMOutboundTable.id, input.id)))
            .get()
          if (raced) return { row: raced, inserted: false, exhausted: false as const }
          const sequenceKey = invalidText ? undefined : providerSequenceKey(input)
          const providerSequence = invalidText ? undefined : allocateProviderSequence(db, input)
          if (providerSequence !== undefined && providerSequence > 65535)
            return { row: undefined, inserted: false, exhausted: true as const }
          const values: typeof IMOutboundTable.$inferInsert = {
            id: input.id,
            project_id: input.projectID,
            platform: input.platform,
            channel_name: input.channelName,
            mode: input.mode,
            target: targetValue(input.target),
            provider_sequence_key: sequenceKey,
            provider_sequence: providerSequence,
            text: input.text,
            format,
            status: invalidText ? "failed" : "pending",
            attempt_count: invalidText ? 0 : 1,
            last_error: invalidText,
            lease_expires_at: invalidText ? null : leaseExpiresAt,
            time_created: Date.now(),
            time_updated: Date.now(),
          }
          const inserted = db.insert(IMOutboundTable).values(values).onConflictDoNothing().returning().get()
          return {
            row:
              inserted ??
              db
                .select()
                .from(IMOutboundTable)
                .where(and(eq(IMOutboundTable.project_id, input.projectID), eq(IMOutboundTable.id, input.id)))
                .get(),
            inserted: !!inserted,
            exhausted: false as const,
          }
        },
        { behavior: "immediate" },
      )
      const pending = pendingResult.row
      if (pendingResult.exhausted) yield* new ProviderSequenceExhaustedError({ channelName: input.channelName })
      if (!pending) return yield* Effect.die(new Error(`Failed to persist outbound message ${input.id}`))
      // Another caller may have inserted this id while this invocation was
      // preparing the send. Returning the durable row avoids a second request.
      if (!pendingResult.inserted) {
        const matches =
          pending.platform === input.platform &&
          pending.channel_name === input.channelName &&
          pending.mode === input.mode &&
          pending.text === input.text &&
          pending.format === format &&
          JSON.stringify(pending.target) === JSON.stringify(targetValue(input.target))
        if (!matches) return yield* new OutboundConflictError({ outboundID: input.id })
        return fromOutboundRow(pending)
      }
      if (invalidText) {
        log.warn("outbound validation failed before provider request", {
          channelName: input.channelName,
          outboundID: input.id,
        })
        return fromOutboundRow(pending)
      }
      const transport = registry.get(input.channelName)
      const capability = transport ? proactiveCapability(transport.capabilities, input.target.scope) : "unsupported"
      if (!transport || transport.platform !== input.platform) {
        const row = updateOutbound(input.projectID, input.id, {
          status: "failed",
          lastError: "IM transport is not registered",
        })
        if (!row) return fromOutboundRow(pending)
        log.warn("outbound transport unavailable", {
          channelName: input.channelName,
          outboundID: input.id,
        })
        return fromOutboundRow(row)
      }
      if (input.mode === "reply" && !transport.capabilities.passiveReply) {
        const row = updateOutbound(input.projectID, input.id, {
          status: "failed",
          lastError: "Passive replies are unsupported",
        })
        return fromOutboundRow(row ?? pending)
      }
      if (input.mode === "proactive" && capability === "unsupported") {
        const row = updateOutbound(input.projectID, input.id, {
          status: "failed",
          lastError: `Proactive ${input.target.scope} messages are unsupported`,
        })
        return fromOutboundRow(row ?? pending)
      }
      log.info("outbound send starting", {
        format,
        platform: input.platform,
        channelName: input.channelName,
        outboundID: input.id,
        mode: input.mode,
        scope: input.target.scope,
        capability,
      })
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.sleep(LEASE_TICK_MS).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    const expires = (yield* Clock.currentTimeMillis) + SEND_LEASE_MS
                    Database.use((db) =>
                      db
                        .update(IMOutboundTable)
                        .set({ lease_expires_at: expires })
                        .where(
                          and(
                            eq(IMOutboundTable.project_id, input.projectID),
                            eq(IMOutboundTable.id, input.id),
                            eq(IMOutboundTable.status, "pending"),
                          ),
                        )
                        .run(),
                    )
                    log.debug("outbound send lease renewed", { outboundID: input.id })
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.sync(() =>
                        log.error("outbound send lease renewal failed", { outboundID: input.id, cause }),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
          return yield* Effect.exit(
            Effect.tryPromise({
              try: () =>
                transport.sendText({
                  target: input.target,
                  text: input.text,
                  format,
                  mode: input.mode,
                  providerClientID: createHash("sha256")
                    .update(JSON.stringify([input.projectID, input.id]))
                    .digest("hex"),
                  ...(pending.provider_sequence !== null && pending.provider_sequence !== undefined
                    ? { providerSequence: pending.provider_sequence }
                    : {}),
                }),
              catch: (error) => error,
            }),
          )
        }),
      )
      if (Exit.isFailure(result)) {
        const rejection = result.cause.reasons.find(
          (reason) =>
            Cause.isFailReason(reason) &&
            (reason.error instanceof ProviderRejectedError || reason.error instanceof SendValidationError),
        )
        // A network failure does not prove the provider did not accept it.
        // Keep `unknown` and never retry implicitly.
        const detail =
          rejection && Cause.isFailReason(rejection)
            ? String(rejection.error)
            : "IM provider acceptance could not be confirmed"
        const status = rejection ? "failed" : "unknown"
        const row = updateOutbound(input.projectID, input.id, { status, lastError: detail })
        log.warn("outbound send did not complete", {
          platform: input.platform,
          channelName: input.channelName,
          outboundID: input.id,
          status,
          error: detail,
        })
        return fromOutboundRow(row ?? pending)
      }
      const sent = result.value
      const row = updateOutbound(input.projectID, input.id, {
        status: "sent",
        providerMessageID: sent.providerMessageID,
      })
      log.info("outbound send completed", {
        platform: input.platform,
        channelName: input.channelName,
        outboundID: input.id,
        providerMessageID: sent.providerMessageID,
      })
      return fromOutboundRow(row ?? pending)
    })

    const sendText = Effect.fn("IM.sendText")(function* (input: SendInput) {
      log.info("outbound send requested", {
        format: input.format ?? "text",
        channelName: input.channelName,
        outboundID: input.id,
        projectID: input.projectID,
      })
      const result = yield* sendTextCore(input)
      log.info("outbound send result returned", {
        channelName: input.channelName,
        outboundID: input.id,
        status: result.status,
        providerMessageID: result.providerMessageID,
      })
      return result
    })

    const markLegacyStatus = Effect.fn("IM.markLegacyStatus")(function* (messageID: string, status: IMLegacyStatus) {
      const allowed =
        status === "processing"
          ? eq(IMMessageTable.legacy_status, "received")
          : or(eq(IMMessageTable.legacy_status, "received"), eq(IMMessageTable.legacy_status, "processing"))
      const row = Database.use((db) =>
        db
          .update(IMMessageTable)
          .set({ legacy_status: status, time_updated: Date.now() })
          .where(and(eq(IMMessageTable.id, messageID), allowed))
          .returning({ id: IMMessageTable.id })
          .get(),
      )
      log.info("IM legacy processing status updated", { messageID, status, found: !!row })
      return !!row
    })

    const markLegacyCompleted = Effect.fn("IM.markLegacyCompleted")(function* (messageID: string) {
      const row = Database.use((db) =>
        db
          .update(IMMessageTable)
          .set({ legacy_status: "completed", time_updated: Date.now() })
          .where(and(eq(IMMessageTable.id, messageID), eq(IMMessageTable.legacy_status, "processing")))
          .returning({ id: IMMessageTable.id })
          .get(),
      )
      return !!row
    })

    const claimLegacyProcessing = Effect.fn("IM.claimLegacyProcessing")(function* (messageID: string) {
      const row = Database.use((db) =>
        db
          .update(IMMessageTable)
          .set({ legacy_status: "processing", time_updated: Date.now() })
          .where(and(eq(IMMessageTable.id, messageID), eq(IMMessageTable.legacy_status, "received")))
          .returning({ id: IMMessageTable.id })
          .get(),
      )
      return !!row
    })

    const hasSubscriptionDelivery = Effect.fn("IM.hasSubscriptionDelivery")(function* (messageID: string) {
      const row = Database.use((db) =>
        db
          .select({ messageID: IMSubscriptionDeliveryTable.message_id })
          .from(IMSubscriptionDeliveryTable)
          .where(eq(IMSubscriptionDeliveryTable.message_id, messageID))
          .get(),
      )
      return !!row
    })

    const reserveProviderSequence = Effect.fn("IM.reserveProviderSequence")(function* (input: {
      platform: IMModel.Platform
      channelName: string
      target: Target
      mode: SendMode
    }) {
      const sequence = Database.transaction((db) => allocateProviderSequence(db, input), { behavior: "immediate" })
      if (sequence !== undefined && sequence > 65535)
        yield* new ProviderSequenceExhaustedError({ channelName: input.channelName })
      return sequence
    })

    return Service.of({
      ingest,
      list,
      recoverPendingSends,
      sendText,
      markLegacyStatus,
      markLegacyCompleted,
      claimLegacyProcessing,
      hasSubscriptionDelivery,
      reserveProviderSequence,
    })
  }),
)

export const defaultLayer = layer
export const runtime = makeRuntime(Service, defaultLayer)
export * as IM from "./service"
