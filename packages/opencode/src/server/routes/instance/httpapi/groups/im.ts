import { Platform, SendMode, TargetScope } from "@/im/model"
import { ProjectID } from "@/project/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ConflictError, InvalidRequestError } from "../errors"
import { ApiNotFoundError } from "../errors"

const root = "/im"

export const TargetPayload = Schema.Struct({
  platform: Platform,
  channelName: Schema.String,
  scope: TargetScope,
  conversationID: Schema.String,
  senderID: Schema.optional(Schema.String),
  replyTo: Schema.optional(Schema.String),
})

export const ChannelInfoSchema = Schema.Struct({
  channelName: Schema.String,
  platform: Schema.Literals(["feishu", "qq", "discord"]),
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  recipientStatus: Schema.Literals(["ready", "missing", "ambiguous", "unsupported"]),
  recipient: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
})

export const MessageSchema = Schema.Struct({
  id: Schema.String,
  platform: Platform,
  channelName: Schema.String,
  eventID: Schema.String,
  ingestSeq: Schema.Number,
  direction: Schema.Literals(["inbound", "outbound"]),
  legacyStatus: Schema.Literals(["received", "processing", "completed", "unknown"]),
  target: TargetPayload,
  senderID: Schema.optional(Schema.String),
  senderName: Schema.optional(Schema.String),
  text: Schema.String,
  timeEvent: Schema.optional(Schema.Number),
  timeCreated: Schema.Number,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export const MessagePageSchema = Schema.Struct({
  items: Schema.Array(MessageSchema),
  nextCursor: Schema.optional(Schema.String),
  checkpoint: Schema.optional(Schema.String),
})

export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  channelName: Schema.String,
  limit: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.String),
  direction: Schema.optional(Schema.Literals(["before", "after"])),
  waitMs: Schema.optional(Schema.NumberFromString),
})

export const SendPayload = Schema.Struct({
  id: Schema.optional(Schema.String),
  channelName: Schema.String,
  text: Schema.String,
})

export const OutboundSchema = Schema.Struct({
  id: Schema.String,
  projectID: ProjectID,
  platform: Platform,
  channelName: Schema.String,
  mode: SendMode,
  target: TargetPayload,
  text: Schema.String,
  status: Schema.Literals(["pending", "sent", "unknown", "failed"]),
  providerMessageID: Schema.optional(Schema.String),
  providerSequence: Schema.optional(Schema.Number),
  attemptCount: Schema.Number,
  lastError: Schema.optional(Schema.String),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})

export const SubscriptionPayload = Schema.Struct({
  sessionID: Schema.String,
  channelName: Schema.String,
  keyword: Schema.optional(Schema.String),
})

export const SubscriptionSchema = Schema.Struct({
  id: Schema.String,
  projectID: ProjectID,
  sessionID: Schema.String,
  sessionDirectory: Schema.String,
  target: TargetPayload,
  senderID: Schema.optional(Schema.String),
  keyword: Schema.optional(Schema.String),
  status: Schema.Literals(["active", "paused", "stopped", "failed"]),
  failureReason: Schema.optional(Schema.String),
  startSeq: Schema.Number,
  deliveryCursor: Schema.Number,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})

export const IMPaths = {
  channels: `${root}/channels`,
  messages: `${root}/messages`,
  send: `${root}/send`,
  subscriptions: `${root}/subscriptions`,
  subscriptionAction: `${root}/subscriptions/:subscriptionID`,
} as const

export const ImApi = HttpApi.make("im").add(
  HttpApiGroup.make("im")
    .add(
      HttpApiEndpoint.get("channels", IMPaths.channels, {
        query: WorkspaceRoutingQuery,
        success: described(
          Schema.Array(ChannelInfoSchema),
          "Configured IM channels with automatic fixed recipient discovery",
        ),
      }).annotateMerge(OpenApi.annotations({ identifier: "im.channels", summary: "List configured IM channels" })),
      HttpApiEndpoint.get("messages", IMPaths.messages, {
        query: ListQuery,
        success: described(MessagePageSchema, "Messages from the channel's fixed user"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "im.messages.list", summary: "Read a channel's fixed user messages" }),
      ),
      HttpApiEndpoint.post("send", IMPaths.send, {
        query: WorkspaceRoutingQuery,
        payload: SendPayload,
        success: described(OutboundSchema, "IM send result"),
        error: [ConflictError, InvalidRequestError],
      }).annotateMerge(OpenApi.annotations({ identifier: "im.send", summary: "Send an explicit IM message" })),
      HttpApiEndpoint.get("subscriptionList", IMPaths.subscriptions, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Array(SubscriptionSchema), "Project IM subscriptions"),
      }).annotateMerge(OpenApi.annotations({ identifier: "im.subscription.list", summary: "List IM subscriptions" })),
      HttpApiEndpoint.post("subscriptionCreate", IMPaths.subscriptions, {
        query: WorkspaceRoutingQuery,
        payload: SubscriptionPayload,
        success: described(SubscriptionSchema, "Created IM subscription"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "im.subscription.create", summary: "Watch a channel's fixed user" }),
      ),
      HttpApiEndpoint.post("subscriptionPause", `${IMPaths.subscriptionAction}/pause`, {
        params: { subscriptionID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(SubscriptionSchema, "Paused IM subscription"),
        error: [ApiNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "im.subscription.pause", summary: "Pause an IM subscription" }),
      ),
      HttpApiEndpoint.post("subscriptionResume", `${IMPaths.subscriptionAction}/resume`, {
        params: { subscriptionID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(SubscriptionSchema, "Resumed IM subscription"),
        error: [ApiNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "im.subscription.resume", summary: "Resume an IM subscription" }),
      ),
      HttpApiEndpoint.post("subscriptionStop", `${IMPaths.subscriptionAction}/stop`, {
        params: { subscriptionID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(SubscriptionSchema, "Stopped IM subscription"),
        error: [ApiNotFoundError, InvalidRequestError],
      }).annotateMerge(OpenApi.annotations({ identifier: "im.subscription.stop", summary: "Stop an IM subscription" })),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "im", description: "Use configured IM channels to message their fixed users." }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
