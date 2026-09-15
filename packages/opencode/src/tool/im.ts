import { InstanceState } from "@/effect/instance-state"
import { IM, type ListInput } from "@/im/service"
import { IMOwner } from "@/im/owner"
import { IMSubscription } from "@/im/subscription"
import type { Target } from "@/im/model"
import { MessageFormat } from "@/im/model"
import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import * as Tool from "./tool"

const log = Log.create({ service: "tool.im" })
const ListParams = Schema.Struct({})
const ReadParams = Schema.Struct({
  channelName: Schema.String,
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String).annotate({
    description:
      "Omit on the first read. Later use the exact opaque checkpoint or nextCursor returned by im_read. Never use numeric watch startSeq/deliveryCursor or invent a cursor.",
  }),
  direction: Schema.optional(Schema.Literals(["before", "after"])),
  waitMs: Schema.optional(Schema.Number),
})
const SendParams = Schema.Struct({
  format: Schema.optional(MessageFormat).annotate({
    description: "Defaults to text. Use markdown for a rich Feishu card; QQ currently supports text only.",
  }),
  channelName: Schema.String,
  text: Schema.String,
  id: Schema.optional(Schema.String).annotate({
    description: "Optional stable idempotency key; normally generated from this tool call.",
  }),
})
const WatchParams = Schema.Struct({
  action: Schema.optional(Schema.Literals(["create", "list", "pause", "resume", "stop"])),
  channelName: Schema.optional(Schema.String),
  subscriptionID: Schema.optional(Schema.String),
  keyword: Schema.optional(Schema.String),
})

function sameRecipient(a: Target, b: Target) {
  return (
    a.platform === b.platform &&
    a.channelName === b.channelName &&
    a.scope === b.scope &&
    a.conversationID === b.conversationID &&
    a.senderID === b.senderID
  )
}

export const IMListTool = Tool.define<typeof ListParams, { count: number }, IMOwner.Service>(
  "im_list",
  Effect.gen(function* () {
    const owner = yield* IMOwner.Service
    return {
      description:
        "List configured IM channels and whether their fixed recipient is ready. No chat ID or project authorization setup is required.",
      parameters: ListParams,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: "im_list", patterns: ["*"], always: ["*"], metadata: {} })
          const rows = yield* owner.list()
          log.info("configured channels listed", { count: rows.length })
          return { title: `${rows.length} IM channels`, output: JSON.stringify(rows), metadata: { count: rows.length } }
        }).pipe(Effect.orDie),
    }
  }),
)

export const IMReadTool = Tool.define<typeof ReadParams, { count: number }, IM.Service | IMOwner.Service>(
  "im_read",
  Effect.gen(function* () {
    const im = yield* IM.Service
    const owner = yield* IMOwner.Service
    return {
      description:
        "Read messages from a configured IM channel's fixed user. Specify only channelName on the first read, never a chat ID or invented cursor. Use returned opaque checkpoints for subsequent reads.",
      parameters: ReadParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "im_read",
            patterns: [params.channelName],
            always: [params.channelName],
            metadata: { channelName: params.channelName },
          })
          const target = yield* owner.resolve(params.channelName)
          const projectID = (yield* InstanceState.context).project.id
          log.info("channel recipient resolved for read", {
            channelName: params.channelName,
            platform: target.platform,
          })
          const page = yield* im.list({
            projectID,
            channelName: params.channelName,
            conversationID: target.conversationID,
            senderID: target.senderID,
            limit: params.limit,
            cursor: params.cursor,
            direction: params.direction ?? "after",
            waitMs: params.waitMs,
          } satisfies ListInput)
          return {
            title: `${page.items.length} IM messages`,
            output: JSON.stringify(page),
            metadata: { count: page.items.length, checkpoint: page.checkpoint, nextCursor: page.nextCursor },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const IMSendTool = Tool.define<typeof SendParams, { status: string }, IM.Service | IMOwner.Service>(
  "im_send",
  Effect.gen(function* () {
    const im = yield* IM.Service
    const owner = yield* IMOwner.Service
    return {
      description:
        "Send through a configured IM channel to its fixed user. Use {channelName,text,format?}; markdown renders a rich Feishu card, omitted format is plain text. Do not supply chat ID, target, or mode.",
      parameters: SendParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "im_send",
            patterns: [params.channelName],
            always: [params.channelName],
            metadata: { channelName: params.channelName },
          })
          const target = yield* owner.resolve(params.channelName)
          const projectID = (yield* InstanceState.context).project.id
          const id = params.id?.trim() || (ctx.callID ? `tool:${ctx.sessionID}:${ctx.callID}` : undefined)
          if (!id) return yield* Effect.fail(new Error("IM send requires a tool call ID or explicit idempotency key"))
          log.info("channel recipient resolved for send", {
            channelName: params.channelName,
            platform: target.platform,
            outboundID: id,
          })
          const result = yield* im.sendText({
            id,
            projectID,
            platform: target.platform,
            channelName: params.channelName,
            mode: "proactive",
            target,
            text: params.text,
            format: params.format,
          })
          return {
            title: `IM send ${result.status}`,
            output: JSON.stringify(result),
            metadata: { status: result.status },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const IMWatchTool = Tool.define<
  typeof WatchParams,
  { subscriptionIDs: string[]; action: string; subscriptionID?: string },
  IMSubscription.Service | IMOwner.Service
>(
  "im_watch",
  Effect.gen(function* () {
    const subscriptions = yield* IMSubscription.Service
    const owner = yield* IMOwner.Service
    return {
      description:
        "Watch a configured IM channel's fixed user in the current session. Create with {channelName,keyword?}; manage with action and subscriptionID. No chat IDs or grants are required.",
      parameters: WatchParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const action = params.action ?? "create"
          const projectID = instance.project.id
          const owned = (yield* subscriptions.list(projectID)).filter(
            (item) => item.sessionID === ctx.sessionID && item.sessionDirectory === instance.directory,
          )
          if (action === "create") {
            if (!params.channelName) return yield* Effect.fail(new Error("im_watch create requires channelName"))
            if (params.subscriptionID)
              return yield* Effect.fail(new Error("im_watch subscriptionID is only valid for control actions"))
            yield* ctx.ask({
              permission: "im_watch",
              patterns: [params.channelName],
              always: [params.channelName],
              metadata: { channelName: params.channelName, action },
            })
            const target = yield* owner.resolve(params.channelName)
            log.info("channel recipient resolved for watch", {
              channelName: params.channelName,
              platform: target.platform,
              sessionID: ctx.sessionID,
            })
            const subscription = yield* subscriptions.create({
              projectID,
              sessionID: ctx.sessionID,
              sessionDirectory: instance.directory,
              target,
              keyword: params.keyword,
            })
            return {
              title: `IM subscription ${subscription.id}`,
              output: JSON.stringify(subscription),
              metadata: { subscriptionIDs: [subscription.id], subscriptionID: subscription.id, action },
            }
          }
          if (params.channelName || params.keyword)
            return yield* Effect.fail(new Error(`im_watch ${action} does not accept channelName or filters`))
          if (action === "list") {
            const channels = [...new Set(owned.map((item) => item.target.channelName))]
            yield* ctx.ask({
              permission: "im_watch",
              patterns: channels.length ? channels : ["none"],
              always: channels,
              metadata: { action },
            })
            return {
              title: `${owned.length} IM subscriptions`,
              output: JSON.stringify(owned),
              metadata: { subscriptionIDs: owned.map((item) => item.id), action },
            }
          }
          if (!params.subscriptionID) return yield* Effect.fail(new Error(`im_watch ${action} requires subscriptionID`))
          const subscription = owned.find((item) => item.id === params.subscriptionID)
          if (!subscription) return yield* Effect.fail(new Error("im_watch subscription is not owned by this session"))
          const channelName = subscription.target.channelName
          yield* ctx.ask({
            permission: "im_watch",
            patterns: [channelName],
            always: [channelName],
            metadata: { channelName, action, subscriptionID: subscription.id },
          })
          if (action === "resume") {
            const current = yield* owner.resolve(channelName)
            if (!sameRecipient(current, subscription.target))
              return yield* Effect.fail(
                new Error("IM recipient changed; create a new watch instead of resuming the old one"),
              )
          }
          log.info("channel watch state changing", { channelName, action, subscriptionID: subscription.id })
          const updated =
            action === "pause"
              ? yield* subscriptions.pause(subscription.id, projectID)
              : action === "resume"
                ? yield* subscriptions.resume(subscription.id, projectID)
                : yield* subscriptions.stop(subscription.id, projectID)
          return {
            title: `IM subscription ${updated.status}`,
            output: JSON.stringify(updated),
            metadata: { subscriptionIDs: [updated.id], subscriptionID: updated.id, action },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export * as IMTools from "./im"
