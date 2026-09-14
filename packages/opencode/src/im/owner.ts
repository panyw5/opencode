import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import * as Lark from "@larksuiteoapi/node-sdk"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { Config } from "@/config/config"
import type { ConfigChannels } from "@/config/channels"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Database, and, eq } from "@/storage/db"
import { makeRuntime } from "@/effect/run-service"
import { IMMessageTable } from "./inbox.sql"
import { IMOwnerTable } from "./owner.sql"
import { Target, type NormalizedMessage } from "./model"
import { registry } from "./transport"

const log = Log.create({ service: "im.owner" })
export type ChannelInfo = {
  channelName: string
  platform: "feishu" | "qq" | "discord"
  enabled: boolean
  running: boolean
  recipientStatus: "ready" | "missing" | "ambiguous" | "unsupported"
  recipient?: { name?: string }
}

export class ChannelNotFoundError extends Schema.TaggedErrorClass<ChannelNotFoundError>()(
  "IMOwner.ChannelNotFoundError",
  { channelName: Schema.String },
) {
  override get message() {
    return `IM channel ${this.channelName} is not configured`
  }
}
export class ChannelDisabledError extends Schema.TaggedErrorClass<ChannelDisabledError>()(
  "IMOwner.ChannelDisabledError",
  { channelName: Schema.String },
) {
  override get message() {
    return `IM channel ${this.channelName} is disabled`
  }
}
export class OwnerNotReadyError extends Schema.TaggedErrorClass<OwnerNotReadyError>()("IMOwner.OwnerNotReadyError", {
  channelName: Schema.String,
}) {
  override get message() {
    return `IM channel ${this.channelName} has no discovered private recipient; send the bot a private message`
  }
}
export class OwnerAmbiguousError extends Schema.TaggedErrorClass<OwnerAmbiguousError>()("IMOwner.OwnerAmbiguousError", {
  channelName: Schema.String,
}) {
  override get message() {
    return `IM channel ${this.channelName} has multiple private recipients; configure one allowed user in the channel`
  }
}
export type ResolveError = ChannelNotFoundError | ChannelDisabledError | OwnerNotReadyError | OwnerAmbiguousError
type Candidate = { conversationID: string; senderID: string; name?: string }
export type Options = {
  legacyPaths?: () => string[]
  verifyFeishu?: (config: ConfigChannels.Feishu, conversationID: string) => Promise<Candidate | undefined>
}
export interface Interface {
  readonly resolve: (channelName: string) => Effect.Effect<Target, ResolveError>
  readonly list: () => Effect.Effect<ChannelInfo[]>
  readonly observe: (message: NormalizedMessage, configuredChannel?: ConfigChannels.Info) => Effect.Effect<void>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/IMOwner") {}

export function appIdentity(config: ConfigChannels.Info) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        config.type === "discord"
          ? [config.type, createHash("sha256").update(config.botToken).digest("hex")]
          : [
              config.type,
              config.appId,
              config.type === "feishu" ? (config.domain ?? "feishu") : (config.apiBaseUrl ?? "https://api.bot.qq.com"),
            ],
      ),
    )
    .digest("hex")
}

function legacyPaths() {
  const home = Global.Path.home
  return [
    ...new Set([
      path.join(Global.Path.state, "channel-sessions.json"),
      path.join(home, ".local/state/opencode/channel-sessions.json"),
      ...["ai.opencode.desktop", "ai.opencode.desktop.dev", "ai.opencode.desktop.beta"].map((app) =>
        path.join(home, "Library/Application Support", app, "opencode/channel-sessions.json"),
      ),
    ]),
  ]
}

export function feishuPrivateOwner(
  chat: { chat_mode?: string; owner_id_type?: string; owner_id?: string },
  conversationID: string,
): Candidate | undefined {
  if (chat.chat_mode === "p2p" && chat.owner_id_type === "open_id" && chat.owner_id?.startsWith("ou_"))
    return { conversationID, senderID: chat.owner_id }
}

async function verifyFeishu(config: ConfigChannels.Feishu, conversationID: string): Promise<Candidate | undefined> {
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
    logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
  })
  const chat = await client.im.chat.get({ path: { chat_id: conversationID }, params: { user_id_type: "open_id" } })
  if (chat.code !== 0 || chat.data?.chat_mode !== "p2p") return
  const owner = feishuPrivateOwner(chat.data, conversationID)
  if (owner) return owner
  const members = await client.im.chatMembers.get({
    path: { chat_id: conversationID },
    params: { member_id_type: "open_id", page_size: 10 },
  })
  const users = members.data?.items?.filter((item) => item.member_id_type === "open_id" && item.member_id) ?? []
  if (members.code !== 0 || members.data?.has_more || users.length !== 1) return
  return { conversationID, senderID: users[0]!.member_id!, name: users[0]!.name }
}

export const makeLayer = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const configService = yield* Config.Service
      const channels = Effect.fn("IMOwner.channels")(function* () {
        return (yield* configService.getGlobal()).channels ?? {}
      })
      const pin = (config: ConfigChannels.Info) => {
        const ids = [...new Set(config.allowedUsers?.filter((id) => id && id !== "*") ?? [])]
        return ids.length === 1 && !config.allowedUsers?.includes("*") ? ids[0] : undefined
      }
      const persist = (
        channelName: string,
        config: ConfigChannels.Feishu | ConfigChannels.QQ,
        candidate: Candidate,
      ) => {
        const identity = appIdentity(config)
        const now = Date.now()
        const row = Database.transaction(
          (db) => {
            const existing = db.select().from(IMOwnerTable).where(eq(IMOwnerTable.channel_name, channelName)).get()
            if (existing && existing.app_identity === identity && (!pin(config) || existing.sender_id === pin(config)))
              return existing
            return db
              .insert(IMOwnerTable)
              .values({
                channel_name: channelName,
                app_identity: identity,
                platform: config.type,
                conversation_id: candidate.conversationID,
                sender_id: candidate.senderID,
                name: candidate.name,
                time_created: now,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: IMOwnerTable.channel_name,
                set: {
                  app_identity: identity,
                  platform: config.type,
                  conversation_id: candidate.conversationID,
                  sender_id: candidate.senderID,
                  name: candidate.name ?? null,
                  time_updated: now,
                },
              })
              .returning()
              .get()
          },
          { behavior: "immediate" },
        )
        log.info("IM fixed recipient persisted", { channelName, platform: config.type })
        return new Target({
          platform: row.platform,
          channelName,
          scope: row.platform === "feishu" ? "chat" : "c2c",
          conversationID: row.conversation_id,
          senderID: row.sender_id,
        })
      }
      const discover = Effect.fn("IMOwner.discover")(function* (
        channelName: string,
        config: ConfigChannels.Feishu | ConfigChannels.QQ,
      ) {
        const identity = appIdentity(config)
        const expectedSender = pin(config)
        const saved = Database.use((db) =>
          db
            .select()
            .from(IMOwnerTable)
            .where(and(eq(IMOwnerTable.channel_name, channelName), eq(IMOwnerTable.app_identity, identity)))
            .get(),
        )
        if (saved && (!expectedSender || saved.sender_id === expectedSender)) {
          return new Target({
            platform: saved.platform,
            channelName,
            scope: saved.platform === "feishu" ? "chat" : "c2c",
            conversationID: saved.conversation_id,
            senderID: saved.sender_id,
          })
        }
        log.info("IM fixed recipient discovery started", {
          channelName,
          platform: config.type,
          pinned: !!expectedSender,
        })
        const rows = Database.use((db) =>
          db
            .select()
            .from(IMMessageTable)
            .where(
              and(
                eq(IMMessageTable.channel_name, channelName),
                eq(IMMessageTable.platform, config.type),
                eq(IMMessageTable.direction, "inbound"),
              ),
            )
            .all(),
        )
        const previousOwner = Database.use((db) =>
          db.select().from(IMOwnerTable).where(eq(IMOwnerTable.channel_name, channelName)).get(),
        )
        const foreignIdentityEvidence = rows.some(
          (row) => typeof row.metadata?.appIdentity === "string" && row.metadata.appIdentity !== identity,
        )
        const candidates = new Map<string, Candidate>()
        for (const row of rows) {
          if (!row.sender_id || (expectedSender && row.sender_id !== expectedSender)) continue
          if (config.type === "feishu" ? row.metadata?.chatType !== "p2p" : row.scope !== "c2c") continue
          // New records carry app identity; historical verified records are imported once.
          if (row.metadata?.appIdentity && row.metadata.appIdentity !== identity) continue
          if (
            !row.metadata?.appIdentity &&
            ((previousOwner && previousOwner.app_identity !== identity) || foreignIdentityEvidence)
          )
            continue
          candidates.set(row.sender_id, {
            conversationID: row.conversation_id,
            senderID: row.sender_id,
            name: row.sender_name ?? undefined,
          })
        }
        if (
          candidates.size === 0 &&
          !(
            config.type === "qq" &&
            ((previousOwner && previousOwner.app_identity !== identity) || foreignIdentityEvidence)
          )
        ) {
          const chats = new Set<string>()
          for (const file of (options.legacyPaths ?? legacyPaths)()) {
            const parsed = yield* Effect.tryPromise(() => fs.readFile(file, "utf8").then(JSON.parse)).pipe(
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (!parsed?.sessions || typeof parsed.sessions !== "object") continue
            for (const key of Object.keys(parsed.sessions)) {
              const [name, chat] = key.split("::")
              if (name === channelName && chat) chats.add(chat)
            }
          }
          for (const chat of chats) {
            if (config.type === "qq") {
              if (!chat.startsWith("private:")) continue
              const senderID = chat.slice("private:".length)
              if (senderID && (!expectedSender || expectedSender === senderID))
                candidates.set(senderID, { conversationID: chat, senderID })
            } else {
              const candidate = yield* Effect.tryPromise(() =>
                (options.verifyFeishu ?? verifyFeishu)(config, chat),
              ).pipe(
                Effect.catch((error) => {
                  log.warn("IM historical private recipient verification failed", { channelName })
                  return Effect.succeed(undefined)
                }),
              )
              if (candidate && (!expectedSender || candidate.senderID === expectedSender))
                candidates.set(candidate.senderID, candidate)
            }
          }
        }
        if (candidates.size > 1) {
          log.warn("IM fixed recipient discovery ambiguous", { channelName, candidates: candidates.size })
          return yield* new OwnerAmbiguousError({ channelName })
        }
        const candidate = candidates.values().next().value
        if (!candidate) {
          log.info("IM fixed recipient missing", { channelName })
          return yield* new OwnerNotReadyError({ channelName })
        }
        return persist(channelName, config, candidate)
      })
      const resolve = Effect.fn("IMOwner.resolve")(function* (channelName: string) {
        const config = (yield* channels())[channelName]
        if (!config) return yield* new ChannelNotFoundError({ channelName })
        if (config.enabled === false) return yield* new ChannelDisabledError({ channelName })
        if (config.type === "discord") return yield* new OwnerNotReadyError({ channelName })
        return yield* discover(channelName, config)
      })
      const list = Effect.fn("IMOwner.list")(function* () {
        const all = yield* channels()
        const result: ChannelInfo[] = []
        for (const [channelName, config] of Object.entries(all)) {
          const item: ChannelInfo = {
            channelName,
            platform: config.type,
            enabled: config.enabled !== false,
            running: registry.get(channelName)?.platform === config.type,
            recipientStatus: config.type === "discord" ? "unsupported" : "missing",
          }
          if (config.type !== "discord") {
            const found = yield* discover(channelName, config).pipe(Effect.exit)
            if (found._tag === "Success") {
              item.recipientStatus = "ready"
              const saved = Database.use((db) =>
                db.select().from(IMOwnerTable).where(eq(IMOwnerTable.channel_name, channelName)).get(),
              )
              item.recipient = saved?.name ? { name: saved.name } : {}
            } else if (
              found.cause.reasons.some(
                (reason) => Cause.isFailReason(reason) && reason.error instanceof OwnerAmbiguousError,
              )
            )
              item.recipientStatus = "ambiguous"
          }
          result.push(item)
        }
        return result
      })
      const observe = Effect.fn("IMOwner.observe")(function* (
        message: NormalizedMessage,
        configuredChannel?: ConfigChannels.Info,
      ) {
        const config = configuredChannel ?? (yield* channels())[message.channelName]
        if (
          !config ||
          config.enabled === false ||
          config.type === "discord" ||
          config.type !== message.platform ||
          !message.senderID
        )
          return
        if (configuredChannel && message.metadata?.appIdentity !== appIdentity(config)) return
        if (config.type === "feishu" ? message.metadata?.chatType !== "p2p" : message.target.scope !== "c2c") return
        if (pin(config) && pin(config) !== message.senderID) return
        // Discovery includes all durable historical candidates and never steals a sticky owner.
        yield* discover(message.channelName, config).pipe(
          Effect.catch((error) => {
            log.warn("IM recipient observation unresolved", { channelName: message.channelName, reason: error._tag })
            return Effect.void
          }),
        )
      })
      return Service.of({ resolve, list, observe })
    }),
  )
export const layer = makeLayer()
export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))
export const runtime = makeRuntime(Service, defaultLayer)
export const resolve = (channelName: string) => Effect.flatMap(Service, (service) => service.resolve(channelName))
export const list = () => Effect.flatMap(Service, (service) => service.list())
export * as IMOwner from "./owner"
