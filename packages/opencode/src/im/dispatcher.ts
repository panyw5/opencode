import { Duration, Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { SessionInput } from "@/session/input"
import { SessionPrompt } from "@/session/prompt"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { IMSubscription } from "./subscription"
import type { MessageInfo } from "./service"
import { Database, and, asc, eq, gt, lte, sql } from "@/storage/db"
import { IMAttachmentTable, IMMessageTable } from "./inbox.sql"
import { SessionInputTable, SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"
import { Target } from "./model"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "im.dispatcher" })

export type DispatchResult = { matched: number; admitted: number; failed: number }
const RECOVERY_MESSAGE_LIMIT = 100

function messageFromRow(row: typeof IMMessageTable.$inferSelect): MessageInfo {
  const attachments = Database.use((db) =>
    db
      .select()
      .from(IMAttachmentTable)
      .where(eq(IMAttachmentTable.message_id, row.id))
      .orderBy(asc(IMAttachmentTable.ordinal))
      .all(),
  )
  return {
    id: row.id,
    platform: row.platform,
    channelName: row.channel_name,
    eventID: row.event_id,
    ingestSeq: row.ingest_seq,
    direction: row.direction,
    legacyStatus: row.legacy_status,
    target: new Target({
      platform: row.platform,
      channelName: row.channel_name,
      scope: row.scope,
      conversationID: row.conversation_id,
      ...(row.sender_id ? { senderID: row.sender_id } : {}),
      ...(row.reply_to ? { replyTo: row.reply_to } : {}),
    }),
    senderID: row.sender_id ?? undefined,
    senderName: row.sender_name ?? undefined,
    text: row.text,
    timeEvent: row.time_event ?? undefined,
    timeCreated: row.time_created,
    metadata: row.metadata ?? undefined,
    ...(attachments.length
      ? {
          attachments: attachments.map((item) => ({
            id: item.id,
            kind: item.kind,
            mime: item.mime,
            size: item.size,
            status: item.status,
            ...(item.filename ? { filename: item.filename } : {}),
            ...(item.sha256 ? { sha256: item.sha256 } : {}),
            ...(item.reason ? { reason: item.reason } : {}),
            ...(item.data ? { data: new Uint8Array(item.data) } : {}),
          })),
        }
      : {}),
  }
}

function promptFor(message: MessageInfo, subscriptionID: string) {
  return {
    text: [
      `<im_message source="${message.platform}" channel="${message.channelName}" subscription="${subscriptionID}">`,
      message.text,
      "</im_message>",
    ].join("\n"),
    metadata: {
      imSource: message.platform,
      imChannel: message.channelName,
      imMessageID: message.id,
      imEventID: message.eventID,
      imSubscriptionID: subscriptionID,
      // Keep external text visibly delimited; it is data, not an instruction.
      externalContent: true,
    },
    files: message.attachments?.flatMap((item) =>
      item.status === "ready"
        ? [
            {
              uri: `im-attachment:${item.id}`,
              mime: item.mime,
              ...(item.filename ? { name: item.filename } : {}),
              description: `WeChat ${item.kind} attachment`,
            },
          ]
        : [],
    ),
  }
}

export const dispatch = Effect.fn("IMDispatcher.dispatch")(function* (message: MessageInfo) {
  const subscriptions = yield* IMSubscription.Service
  const inbox = yield* SessionInput.Service
  const prompt = yield* SessionPrompt.Service
  const lifecycle = yield* LocationLifecycle.Service

  const matches = yield* subscriptions.matching({
    messageID: message.id,
    platform: message.platform,
    channelName: message.channelName,
    scope: message.target.scope,
    conversationID: message.target.conversationID,
    senderID: message.senderID,
    text: message.text,
    ingestSeq: message.ingestSeq,
  })
  let admitted = 0
  let failed = 0
  const bySession = new Map<string, (typeof matches)[number][]>()
  for (const subscription of matches) {
    const group = bySession.get(subscription.sessionID) ?? []
    group.push(subscription)
    bySession.set(subscription.sessionID, group)
  }
  for (const group of bySession.values()) {
    const subscription = group[0]!
    // One session should receive one copy even when multiple matching
    // filters target it; different sessions retain independent delivery.
    const admissionID = `evt_im_${message.id}_${subscription.sessionID}`
    const result = yield* inbox
      .admit({
        id: admissionID,
        sessionID: subscription.sessionID,
        prompt: promptFor(message, subscription.id),
        source: `im:${message.platform}:${message.channelName}`,
        delivery: "deferred",
      })
      .pipe(Effect.exit)
    if (result._tag === "Failure") {
      failed++
      yield* subscriptions.markFailed(subscription.id, subscription.projectID, String(result.cause)).pipe(Effect.ignore)
      log.error("IM subscription admission failed", { subscriptionID: subscription.id, messageID: message.id })
      continue
    }
    admitted++
    for (const matched of group) {
      yield* subscriptions.recordDelivery(matched.id, message.id, message.ingestSeq)
      // Cursor advances only after durable admission. If this process dies
      // before advancing, stable admissionID makes replay idempotent.
      yield* subscriptions.advance(matched.id, message.ingestSeq)
    }
    const drain = yield* lifecycle
      .provide(
        { directory: subscription.sessionDirectory, purpose: "background-job" },
        prompt.drain(subscription.sessionID),
      )
      .pipe(Effect.exit)
    if (drain._tag === "Failure") {
      failed++
      log.error("IM subscription drain failed", {
        subscriptionID: subscription.id,
        sessionID: subscription.sessionID,
        messageID: message.id,
        cause: drain.cause,
      })
    }
  }
  log.info("IM dispatch completed", {
    messageID: message.id,
    matched: matches.length,
    admitted,
    failed,
    truncated: false,
  })
  return { matched: matches.length, admitted, failed }
})

export const dispatchMessage = (message: MessageInfo) => AppRuntime.runPromise(dispatch(message))

/** Replay durable messages after a process/channel restart. */
export const recover = Effect.fn("IMDispatcher.recover")(function* () {
  const subscriptions = yield* IMSubscription.Service
  const prompt = yield* SessionPrompt.Service
  const lifecycle = yield* LocationLifecycle.Service
  const active = yield* subscriptions.activeAll()
  let scanned = 0
  let dispatched = 0
  let failed = 0

  for (const subscription of active) {
    // Bound each query and advance a local keyset cursor. The tail snapshot
    // prevents a busy channel from extending one recovery run indefinitely.
    const tail = Database.use(
      (db) =>
        db
          .select({ value: sql<number>`coalesce(max(${IMMessageTable.ingest_seq}), -1)` })
          .from(IMMessageTable)
          .get()?.value ?? -1,
    )
    let cursor = subscription.startSeq
    while (cursor < tail) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(IMMessageTable)
          .where(
            and(
              eq(IMMessageTable.platform, subscription.target.platform),
              eq(IMMessageTable.channel_name, subscription.target.channelName),
              eq(IMMessageTable.scope, subscription.target.scope),
              eq(IMMessageTable.conversation_id, subscription.target.conversationID),
              gt(IMMessageTable.ingest_seq, cursor),
              lte(IMMessageTable.ingest_seq, tail),
            ),
          )
          .orderBy(asc(IMMessageTable.ingest_seq))
          .limit(RECOVERY_MESSAGE_LIMIT)
          .all(),
      )
      if (rows.length === 0) break
      scanned += rows.length
      for (const row of rows) {
        const result = yield* dispatch(messageFromRow(row)).pipe(Effect.exit)
        if (result._tag === "Success") {
          dispatched += result.value.admitted
          failed += result.value.failed
        } else {
          failed++
          log.error("IM durable recovery dispatch failed", {
            subscriptionID: subscription.id,
            messageID: row.id,
            cause: result.cause,
          })
        }
      }
      cursor = rows[rows.length - 1]!.ingest_seq
    }
  }

  // Drain only after durable message replay has had a chance to complete
  // admit/recordDelivery. This closes the admit-before-record crash window.
  // Subscription status is not a valid filter: stop/pause/revoke only affect
  // future admission, while accepted IM inputs remain recoverable.
  const pendingOwners = Database.use((db) =>
    db
      .select({ sessionID: SessionInputTable.session_id, directory: SessionTable.directory })
      .from(SessionInputTable)
      .innerJoin(SessionTable, eq(SessionTable.id, SessionInputTable.session_id))
      .where(and(sql`${SessionInputTable.id} GLOB 'evt_im_*'`, eq(SessionInputTable.delivery, "deferred")))
      .orderBy(asc(SessionInputTable.session_id), asc(SessionInputTable.admitted_seq))
      .all(),
  )
  const ownerDirectories = new Map<string, string>()
  for (const owner of pendingOwners) ownerDirectories.set(owner.sessionID, owner.directory)
  for (const [sessionID, directory] of ownerDirectories) {
    const result = yield* lifecycle
      .provide({ directory, purpose: "background-job" }, prompt.drain(sessionID as SessionID))
      .pipe(Effect.exit)
    if (result._tag === "Failure") {
      failed++
      log.error("IM pending owner drain failed", { sessionID, directory, cause: result.cause })
    } else {
      log.info("IM pending owner drained", { sessionID, directory })
    }
  }
  log.info("IM durable recovery completed", {
    subscriptions: active.length,
    scanned,
    dispatched,
    failed,
    truncated: false,
  })
  return { subscriptions: active.length, scanned, dispatched, failed }
})

export const recoverMessages = () => AppRuntime.runPromise(recover())

/** Recover with bounded, cancellation-aware Effect retries and backoff. */
export const recoverWithRetry = Effect.fn("IMDispatcher.recoverWithRetry")(function* (maxAttempts = 3) {
  const attempts = Math.max(1, Math.floor(maxAttempts))
  let last = { subscriptions: 0, scanned: 0, dispatched: 0, failed: 1 }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = yield* recover().pipe(Effect.exit)
    last = result._tag === "Success" ? result.value : { subscriptions: 0, scanned: 0, dispatched: 0, failed: 1 }
    if (result._tag === "Failure") log.error("IM durable recovery attempt failed", { attempt, cause: result.cause })
    if (last.failed === 0) return last
    if (attempt < attempts) {
      const delay = attempt * 1000
      log.warn("IM durable recovery retry scheduled", { attempt, maxAttempts: attempts, delay, failed: last.failed })
      yield* Effect.sleep(Duration.millis(delay))
    }
  }
  return last
})

export async function recoverMessagesWithRetry(maxAttempts = 3) {
  return AppRuntime.runPromise(recoverWithRetry(maxAttempts))
}

export * as IMDispatcher from "./dispatcher"
