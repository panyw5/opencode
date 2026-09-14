import { IM } from "@/im/service"
import { IMOwner } from "@/im/owner"
import { IMSubscription } from "@/im/subscription"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ListQuery, SendPayload, SubscriptionPayload } from "../groups/im"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { ApiNotFoundError, ConflictError, InvalidRequestError } from "../errors"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "httpapi.im" })

export const imHandlers = HttpApiBuilder.group(InstanceHttpApi, "im", (handlers) =>
  Effect.gen(function* () {
    const im = yield* IM.Service
    const owner = yield* IMOwner.Service
    const subscriptions = yield* IMSubscription.Service
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
