import { and, asc, eq, gt, inArray, lt, or, sql } from "@/storage/db"
import { Database } from "@/storage/db"
import { Context, Effect, Layer, Schema } from "effect"
import type { ProjectID } from "@/project/schema"
import type { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { IMMessageTable, IMSequenceTable } from "./inbox.sql"
import { IMSubscriptionDeliveryTable, IMSubscriptionTable, type IMSubscriptionStatus } from "./subscription.sql"
import { isTargetScopeSupported, Target, type IMModel } from "./model"
import * as Log from "@opencode-ai/core/util/log"
import { Identifier } from "@/id/id"
import { directorySqlEq } from "@/util/directory-sql"
import { IMOwner } from "./owner"

const log = Log.create({ service: "im.subscription" })

export type CreateInput = {
  projectID: ProjectID
  sessionID: SessionID
  sessionDirectory: string
  target: Target
  senderID?: string
  keyword?: string
}

export type Info = CreateInput & {
  id: string
  status: IMSubscriptionStatus
  failureReason?: string
  deliveryCursor: number
  startSeq: number
  timeCreated: number
  timeUpdated: number
}

export class SubscriptionNotFoundError extends Schema.TaggedErrorClass<SubscriptionNotFoundError>()(
  "IMSubscription.NotFoundError",
  { subscriptionID: Schema.String },
) {}

export class SubscriptionDeniedError extends Schema.TaggedErrorClass<SubscriptionDeniedError>()(
  "IMSubscription.DeniedError",
  { projectID: Schema.String },
) {}

export class SubscriptionSessionError extends Schema.TaggedErrorClass<SubscriptionSessionError>()(
  "IMSubscription.SessionError",
  { sessionID: Schema.String },
) {}

export class SubscriptionTargetError extends Schema.TaggedErrorClass<SubscriptionTargetError>()(
  "IMSubscription.TargetError",
  {},
) {}

export interface Interface {
  readonly list: (projectID: ProjectID) => Effect.Effect<Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<Info, SubscriptionSessionError | SubscriptionTargetError>
  readonly pause: (subscriptionID: string, projectID: ProjectID) => Effect.Effect<Info, SubscriptionNotFoundError>
  readonly resume: (subscriptionID: string, projectID: ProjectID) => Effect.Effect<Info, SubscriptionNotFoundError>
  readonly stop: (subscriptionID: string, projectID: ProjectID) => Effect.Effect<Info, SubscriptionNotFoundError>
  readonly matching: (message: {
    messageID: string
    platform: IMModel.Platform
    channelName: string
    scope: IMModel.TargetScope
    conversationID: string
    senderID?: string
    text: string
    ingestSeq: number
  }) => Effect.Effect<Info[]>
  readonly advance: (subscriptionID: string, ingestSeq: number) => Effect.Effect<boolean>
  readonly recordDelivery: (subscriptionID: string, messageID: string, ingestSeq: number) => Effect.Effect<boolean>
  readonly markFailed: (subscriptionID: string, projectID: ProjectID, reason: string) => Effect.Effect<boolean>
  readonly activeAll: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/IMSubscription") {}

type Row = typeof IMSubscriptionTable.$inferSelect

function fromRow(row: Row, sessionDirectory = ""): Info {
  return {
    id: row.id,
    projectID: row.project_id,
    sessionID: row.session_id,
    sessionDirectory,
    target: new Target({
      platform: row.platform,
      channelName: row.channel_name,
      scope: row.scope,
      conversationID: row.conversation_id,
      ...(row.sender_id ? { senderID: row.sender_id } : {}),
    }),
    ...(row.sender_id ? { senderID: row.sender_id } : {}),
    ...(row.keyword ? { keyword: row.keyword } : {}),
    status: row.status,
    failureReason: row.failure_reason ?? undefined,
    deliveryCursor: row.delivery_cursor,
    startSeq: row.start_seq,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const owners = yield* IMOwner.Service
    const list = Effect.fn("IMSubscription.list")(function* (projectID: ProjectID) {
      return Database.use((db) =>
        db
          .select({ subscription: IMSubscriptionTable, directory: SessionTable.directory })
          .from(IMSubscriptionTable)
          .innerJoin(SessionTable, eq(SessionTable.id, IMSubscriptionTable.session_id))
          .where(eq(IMSubscriptionTable.project_id, projectID))
          .orderBy(asc(IMSubscriptionTable.time_created))
          .all()
          .map((item) => ({ ...fromRow(item.subscription), sessionDirectory: item.directory })),
      )
    })

    const activeAll = Effect.fn("IMSubscription.activeAll")(function* () {
      return Database.use((db) =>
        db
          .select({ subscription: IMSubscriptionTable, directory: SessionTable.directory })
          .from(IMSubscriptionTable)
          .innerJoin(SessionTable, eq(SessionTable.id, IMSubscriptionTable.session_id))
          .where(eq(IMSubscriptionTable.status, "active"))
          .orderBy(asc(IMSubscriptionTable.time_created))
          .all()
          .map((item) => ({ ...fromRow(item.subscription), sessionDirectory: item.directory })),
      )
    })

    const create = Effect.fn("IMSubscription.create")(function* (input: CreateInput) {
      if (input.target.senderID && input.senderID && input.target.senderID !== input.senderID)
        yield* new SubscriptionTargetError({})
      const senderID = input.senderID ?? input.target.senderID
      if (!isTargetScopeSupported(input.target.platform, input.target.scope)) yield* new SubscriptionTargetError({})
      const session = Database.use((db) =>
        db
          .select()
          .from(SessionTable)
          .where(
            and(
              eq(SessionTable.id, input.sessionID),
              eq(SessionTable.project_id, input.projectID),
              directorySqlEq(SessionTable.directory, input.sessionDirectory),
            ),
          )
          .get(),
      )
      if (!session) yield* new SubscriptionSessionError({ sessionID: input.sessionID })
      const id = Identifier.create("imsub", "ascending")
      const now = Date.now()
      const startSeq = Database.use((db) => {
        const counter = db.select().from(IMSequenceTable).where(eq(IMSequenceTable.id, "im_message")).get()
        return counter
          ? counter.next_ingest_seq - 1
          : (db
              .select({ value: sql<number>`coalesce(max(${IMMessageTable.ingest_seq}), -1)` })
              .from(IMMessageTable)
              .get()?.value ?? -1)
      })
      const row = Database.use((db) =>
        db
          .insert(IMSubscriptionTable)
          .values({
            id,
            project_id: input.projectID,
            session_id: input.sessionID,
            platform: input.target.platform,
            channel_name: input.target.channelName,
            scope: input.target.scope,
            conversation_id: input.target.conversationID,
            sender_id: senderID,
            keyword: input.keyword,
            status: "active",
            start_seq: startSeq,
            delivery_cursor: startSeq,
            time_created: now,
            time_updated: now,
          })
          .returning()
          .get(),
      )
      log.info("IM subscription created", {
        subscriptionID: id,
        projectID: input.projectID,
        sessionID: input.sessionID,
        channelName: input.target.channelName,
        conversationID: input.target.conversationID,
      })
      return {
        ...fromRow(row),
        sessionDirectory: input.sessionDirectory,
        ...(senderID ? { senderID } : {}),
        ...(input.keyword ? { keyword: input.keyword } : {}),
      }
    })

    const change = (status: IMSubscriptionStatus) =>
      Effect.fn(`IMSubscription.${status}`)(function* (subscriptionID: string, projectID: ProjectID) {
        const row = Database.use((db) =>
          db
            .update(IMSubscriptionTable)
            .set({
              status,
              time_updated: Date.now(),
              failure_reason: status === "failed" ? "manually marked failed" : null,
            })
            .where(and(eq(IMSubscriptionTable.id, subscriptionID), eq(IMSubscriptionTable.project_id, projectID)))
            .returning()
            .get(),
        )
        if (!row) yield* new SubscriptionNotFoundError({ subscriptionID })
        return fromRow(row)
      })

    const matching = Effect.fn("IMSubscription.matching")(function* (message: {
      messageID: string
      platform: IMModel.Platform
      channelName: string
      scope: IMModel.TargetScope
      conversationID: string
      senderID?: string
      text: string
      ingestSeq: number
    }) {
      const rows = Database.use((db) =>
        db
          .select({ subscription: IMSubscriptionTable, directory: SessionTable.directory })
          .from(IMSubscriptionTable)
          .innerJoin(SessionTable, eq(SessionTable.id, IMSubscriptionTable.session_id))
          .where(
            and(
              eq(IMSubscriptionTable.platform, message.platform),
              eq(IMSubscriptionTable.channel_name, message.channelName),
              eq(IMSubscriptionTable.scope, message.scope),
              eq(IMSubscriptionTable.conversation_id, message.conversationID),
              eq(IMSubscriptionTable.status, "active"),
            ),
          )
          .all(),
      )
      if (rows.length === 0) return []
      const owner = yield* owners.resolve(message.channelName).pipe(
        Effect.catch((error) => {
          log.info("IM subscription admission skipped; channel recipient unavailable", {
            channelName: message.channelName,
            reason: error._tag,
          })
          return Effect.succeed(undefined)
        }),
      )
      if (
        !owner ||
        owner.platform !== message.platform ||
        owner.scope !== message.scope ||
        owner.conversationID !== message.conversationID ||
        !owner.senderID ||
        owner.senderID !== message.senderID
      ) {
        log.info("IM subscription admission skipped; message is not from current fixed recipient", {
          channelName: message.channelName,
          messageID: message.messageID,
        })
        return []
      }
      const delivered = rows.length
        ? new Set(
            Database.use((db) =>
              db
                .select({ subscriptionID: IMSubscriptionDeliveryTable.subscription_id })
                .from(IMSubscriptionDeliveryTable)
                .where(
                  and(
                    eq(IMSubscriptionDeliveryTable.message_id, message.messageID),
                    inArray(
                      IMSubscriptionDeliveryTable.subscription_id,
                      rows.map((row) => row.subscription.id),
                    ),
                  ),
                )
                .all()
                .map((row) => row.subscriptionID),
            ),
          )
        : new Set<string>()
      return rows
        .filter(
          (row) =>
            row.subscription.sender_id === owner.senderID &&
            message.ingestSeq > row.subscription.start_seq &&
            !delivered.has(row.subscription.id) &&
            (!row.subscription.sender_id || row.subscription.sender_id === message.senderID) &&
            (!row.subscription.keyword || message.text.includes(row.subscription.keyword)),
        )
        .map((item) => ({ ...fromRow(item.subscription), sessionDirectory: item.directory }))
    })

    const advance = Effect.fn("IMSubscription.advance")(function* (subscriptionID: string, ingestSeq: number) {
      const row = Database.use((db) =>
        db
          .update(IMSubscriptionTable)
          .set({ delivery_cursor: ingestSeq, time_updated: Date.now() })
          .where(
            and(
              eq(IMSubscriptionTable.id, subscriptionID),
              eq(IMSubscriptionTable.status, "active"),
              lt(IMSubscriptionTable.delivery_cursor, ingestSeq),
            ),
          )
          .returning({ id: IMSubscriptionTable.id })
          .get(),
      )
      return !!row
    })

    const recordDelivery = Effect.fn("IMSubscription.recordDelivery")(function* (
      subscriptionID: string,
      messageID: string,
      ingestSeq: number,
    ) {
      return Database.transaction(
        (db) => {
          const row = db
            .insert(IMSubscriptionDeliveryTable)
            .values({
              subscription_id: subscriptionID,
              message_id: messageID,
              ingest_seq: ingestSeq,
              status: "admitted",
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .onConflictDoNothing()
            .returning({ messageID: IMSubscriptionDeliveryTable.message_id })
            .get()
          db.update(IMMessageTable)
            .set({ legacy_status: "completed", time_updated: Date.now() })
            .where(
              and(
                eq(IMMessageTable.id, messageID),
                or(eq(IMMessageTable.legacy_status, "received"), eq(IMMessageTable.legacy_status, "processing")),
              ),
            )
            .run()
          return !!row
        },
        { behavior: "immediate" },
      )
    })

    const markFailed = Effect.fn("IMSubscription.markFailed")(function* (
      subscriptionID: string,
      projectID: ProjectID,
      reason: string,
    ) {
      const row = Database.use((db) =>
        db
          .update(IMSubscriptionTable)
          .set({ status: "failed", failure_reason: reason, time_updated: Date.now() })
          .where(and(eq(IMSubscriptionTable.id, subscriptionID), eq(IMSubscriptionTable.project_id, projectID)))
          .returning({ id: IMSubscriptionTable.id })
          .get(),
      )
      return !!row
    })

    return Service.of({
      list,
      activeAll,
      create,
      pause: change("paused"),
      resume: change("active"),
      stop: change("stopped"),
      matching,
      advance,
      recordDelivery,
      markFailed,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(IMOwner.defaultLayer))
export * as IMSubscription from "./subscription"
