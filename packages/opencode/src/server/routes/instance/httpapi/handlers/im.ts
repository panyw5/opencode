import { IM } from "@/im/service"
import { IMOwner } from "@/im/owner"
import { IMSubscription } from "@/im/subscription"
import { Effect, Semaphore } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ListQuery, SendPayload, SubscriptionPayload } from "../groups/im"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { ApiNotFoundError, ConflictError, InvalidRequestError } from "../errors"
import * as Log from "@opencode-ai/core/util/log"
import { Config } from "@/config/config"
import * as WechatLogin from "@/channel/wechat-login"
import { channelStatus } from "@/channel/wechat"
import { WechatStorage } from "@/channel/wechat-storage"
import { GlobalBus } from "@/bus/global"
import { Event } from "@/server/event"
import { refreshWechatChannel } from "@/channel/manager"

const log = Log.create({ service: "httpapi.im" })

export const imHandlers = HttpApiBuilder.group(InstanceHttpApi, "im", (handlers) =>
  Effect.gen(function* () {
    const im = yield* IM.Service
    const owner = yield* IMOwner.Service
    const subscriptions = yield* IMSubscription.Service
    const config = yield* Config.Service
    const authLocks = new Map<string, ReturnType<typeof Semaphore.makeUnsafe>>()
    const bindingLock = Semaphore.makeUnsafe(1)
    const committedAttempts = new Set<string>()
    const authLock = (name: string) => {
      let lock = authLocks.get(name)
      if (!lock) {
        lock = Semaphore.makeUnsafe(1)
        authLocks.set(name, lock)
      }
      return lock
    }
    const validateWechatName = Effect.fn("IMHttpApi.wechat.validate")(function* (channelName: string) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(channelName))
        return yield* new InvalidRequestError({
          message: "Channel name must contain 1-128 letters, digits, dots, underscores or hyphens",
        })
      const existing = (yield* config.getGlobal()).channels?.[channelName]
      if (existing && existing.type !== "wechat")
        return yield* new InvalidRequestError({ message: "This channel name belongs to another platform" })
    })
    const wechatRequest = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: () =>
          new InvalidRequestError({
            message: "WeChat authorization request failed or expired; retry or refresh the QR code",
          }),
      })
    const wechatStart = Effect.fn("IMHttpApi.wechat.start")(function* (ctx: { payload: { channelName: string } }) {
      yield* validateWechatName(ctx.payload.channelName)
      log.info("WeChat QR authorization started", { channelName: ctx.payload.channelName })
      return yield* wechatRequest(() => WechatLogin.startLogin(ctx.payload))
    })
    const wechatPoll = Effect.fn("IMHttpApi.wechat.poll")(function* (ctx: {
      payload: { channelName: string; attemptID: string; verifyCode?: string }
    }) {
      yield* validateWechatName(ctx.payload.channelName)
      const result = yield* wechatRequest(() => WechatLogin.pollLogin(ctx.payload))
      if (result.status === "confirmed" && result.account) {
        const account = result.account
        yield* authLock(ctx.payload.channelName).withPermits(1)(
          Effect.gen(function* () {
            if (committedAttempts.has(result.attemptID)) return
            const current = yield* wechatRequest(() => WechatLogin.status(ctx.payload))
            const credentials = yield* wechatRequest(() => new WechatStorage().loadCredentials(ctx.payload.channelName))
            if (
              !("attemptID" in current) ||
              current.attemptID !== result.attemptID ||
              current.status !== "confirmed" ||
              credentials?.botId !== account.botId ||
              credentials.baseUrl !== account.baseUrl ||
              credentials.scannerUserId !== account.scannerUserId
            )
              return yield* new InvalidRequestError({
                message: "WeChat authorization was replaced; use the latest QR code",
              })
            const all = yield* config.getGlobal()
            const existing = all.channels?.[ctx.payload.channelName]
            if (existing && existing.type !== "wechat")
              return yield* new InvalidRequestError({ message: "Channel platform changed during authorization" })
            const channel = { ...(existing ?? {}), type: "wechat" as const, ...account }
            const updated = yield* config.updateGlobal({
              channels: { ...all.channels, [ctx.payload.channelName]: channel },
            })
            if (!updated.changed) yield* wechatRequest(() => refreshWechatChannel(ctx.payload.channelName, channel))
            if (updated.changed)
              GlobalBus.emit("event", {
                directory: "global",
                payload: { type: Event.ConfigUpdated.type, properties: updated.info },
              })
            log.info("WeChat account binding committed", { channelName: ctx.payload.channelName })
            committedAttempts.add(result.attemptID)
            if (committedAttempts.size > 128) committedAttempts.delete(committedAttempts.values().next().value!)
          }).pipe(bindingLock.withPermits(1)),
        )
      }
      return result
    })
    const wechatCancel = Effect.fn("IMHttpApi.wechat.cancel")(function* (ctx: {
      payload: { channelName: string; attemptID: string }
    }) {
      yield* validateWechatName(ctx.payload.channelName)
      return yield* wechatRequest(() => WechatLogin.cancelLogin(ctx.payload))
    })
    const wechatStatus = Effect.fn("IMHttpApi.wechat.status")(function* (ctx: { query: { channelName: string } }) {
      yield* validateWechatName(ctx.query.channelName)
      const existing = (yield* config.getGlobal()).channels?.[ctx.query.channelName]
      if (!existing) return { channelName: ctx.query.channelName, status: "unconfigured" as const }
      if (existing.type !== "wechat") return yield* new InvalidRequestError({ message: "Not a WeChat channel" })
      if (existing.enabled === false)
        return { channelName: ctx.query.channelName, status: "stopped" as const, botId: existing.botId }
      if (!existing.botId) return { channelName: ctx.query.channelName, status: "awaiting_login" as const }
      return channelStatus(ctx.query.channelName)
    })
    const resolve = (channelName: string) =>
      owner.resolve(channelName).pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))

    const channels = Effect.fn("IMHttpApi.channels")(function* () {
      const rows = yield* owner.list()
      log.info("configured channels listed", { count: rows.length })
      return rows
    })
    const messages = Effect.fn("IMHttpApi.messages")(function* (ctx: { query: typeof ListQuery.Type }) {
      const target = yield* resolve(ctx.query.channelName)
      log.info("channel recipient resolved for read", { channelName: ctx.query.channelName, platform: target.platform })
      return yield* im
        .list({
          projectID: (yield* InstanceState.context).project.id,
          channelName: ctx.query.channelName,
          conversationID: target.conversationID,
          senderID: target.senderID,
          limit: ctx.query.limit,
          cursor: ctx.query.cursor,
          direction: ctx.query.direction,
          waitMs: ctx.query.waitMs,
        })
        .pipe(
          Effect.catchTag("IM.InvalidCursorError", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message })),
          ),
        )
    })
    const send = Effect.fn("IMHttpApi.send")(function* (ctx: { payload: typeof SendPayload.Type }) {
      const target = yield* resolve(ctx.payload.channelName)
      const id = ctx.payload.id ?? `http:${crypto.randomUUID()}`
      log.info("channel recipient resolved for send", {
        channelName: ctx.payload.channelName,
        platform: target.platform,
        outboundID: id,
      })
      return yield* im
        .sendText({
          id,
          projectID: (yield* InstanceState.context).project.id,
          channelName: ctx.payload.channelName,
          platform: target.platform,
          mode: "proactive",
          target,
          text: ctx.payload.text,
          format: ctx.payload.format,
        })
        .pipe(
          Effect.catchTag("IM.OutboundConflictError", (error) =>
            Effect.fail(new ConflictError({ message: error.message, resource: error.outboundID })),
          ),
          Effect.catchTag("IM.TargetMismatchError", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message })),
          ),
          Effect.catchTag("IM.InvalidReplyError", (error) =>
            Effect.fail(new InvalidRequestError({ message: error.message })),
          ),
          Effect.catchTag("IM.ProviderSequenceExhaustedError", () =>
            Effect.fail(new InvalidRequestError({ message: "The provider message sequence is exhausted" })),
          ),
        )
    })
    const subscriptionList = Effect.fn("IMHttpApi.subscriptionList")(function* () {
      const instance = yield* InstanceState.context
      return (yield* subscriptions.list(instance.project.id)).filter(
        (item) => item.sessionDirectory === instance.directory,
      )
    })
    const subscriptionCreate = Effect.fn("IMHttpApi.subscriptionCreate")(function* (ctx: {
      payload: typeof SubscriptionPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const target = yield* resolve(ctx.payload.channelName)
      log.info("channel recipient resolved for watch", {
        channelName: ctx.payload.channelName,
        platform: target.platform,
        sessionID: ctx.payload.sessionID,
      })
      return yield* subscriptions
        .create({
          projectID: instance.project.id,
          sessionID: SessionID.make(ctx.payload.sessionID),
          sessionDirectory: instance.directory,
          target,
          keyword: ctx.payload.keyword,
        })
        .pipe(
          Effect.catchTag("IMSubscription.SessionError", (error) =>
            Effect.fail(
              new InvalidRequestError({
                message: `Session ${error.sessionID} does not belong to this project directory`,
              }),
            ),
          ),
          Effect.catchTag("IMSubscription.TargetError", () =>
            Effect.fail(new InvalidRequestError({ message: "Invalid channel recipient" })),
          ),
        )
    })
    const subscriptionChange = (action: "pause" | "resume" | "stop") =>
      Effect.fn(`IMHttpApi.subscription.${action}`)(function* (ctx: { params: { subscriptionID: string } }) {
        const instance = yield* InstanceState.context
        const projectID = instance.project.id
        const subscription = (yield* subscriptions.list(projectID)).find(
          (item) => item.id === ctx.params.subscriptionID && item.sessionDirectory === instance.directory,
        )
        if (!subscription)
          return yield* new ApiNotFoundError({
            name: "NotFoundError",
            data: { message: `IM subscription not found: ${ctx.params.subscriptionID}` },
          })
        if (action === "resume") {
          const current = yield* resolve(subscription.target.channelName)
          const prior = subscription.target
          if (
            current.platform !== prior.platform ||
            current.scope !== prior.scope ||
            current.conversationID !== prior.conversationID ||
            current.senderID !== prior.senderID
          )
            return yield* new InvalidRequestError({
              message: "IM recipient changed; create a new watch instead of resuming the old one",
            })
        }
        log.info("channel watch state changing", {
          action,
          channelName: subscription.target.channelName,
          subscriptionID: subscription.id,
        })
        return yield* subscriptions[action](subscription.id, projectID).pipe(
          Effect.catchTag("IMSubscription.NotFoundError", (error) =>
            Effect.fail(
              new ApiNotFoundError({
                name: "NotFoundError",
                data: { message: `IM subscription not found: ${error.subscriptionID}` },
              }),
            ),
          ),
        )
      })

    return handlers
      .handle("wechatLoginStart", (ctx) => authLock(ctx.payload.channelName).withPermits(1)(wechatStart(ctx)))
      .handle("wechatLoginPoll", wechatPoll)
      .handle("wechatLoginCancel", (ctx) => authLock(ctx.payload.channelName).withPermits(1)(wechatCancel(ctx)))
      .handle("wechatStatus", wechatStatus)
      .handle("channels", channels)
      .handle("messages", messages)
      .handle("send", send)
      .handle("subscriptionList", subscriptionList)
      .handle("subscriptionCreate", subscriptionCreate)
      .handle("subscriptionPause", subscriptionChange("pause"))
      .handle("subscriptionResume", subscriptionChange("resume"))
      .handle("subscriptionStop", subscriptionChange("stop"))
  }),
)
