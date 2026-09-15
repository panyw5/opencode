import { Platform, SendMode, TargetScope, MessageFormat } from "@/im/model"
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
  platform: Schema.Literals(["feishu", "qq", "discord", "wechat"]),
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
  attachments: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["image", "voice", "file", "video"]),
    mime: Schema.String,
    filename: Schema.optional(Schema.String),
    size: Schema.Int,
    sha256: Schema.optional(Schema.String),
    status: Schema.Literals(["ready", "unavailable", "rejected"]),
    reason: Schema.optional(Schema.String),
  }))),
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
  format: Schema.optional(MessageFormat).annotate({
    description: "text by default; markdown sends a rich Feishu card.",
  }),
  id: Schema.optional(Schema.String),
  channelName: Schema.String,
  text: Schema.String,
})

export const OutboundSchema = Schema.Struct({
  format: Schema.optional(MessageFormat),
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

export const WechatLoginPayload = Schema.Struct({ channelName: Schema.String })
export const WechatPollPayload = Schema.Struct({
  channelName: Schema.String,
  attemptID: Schema.String,
  verifyCode: Schema.optional(Schema.String),
})
export const WechatCancelPayload = Schema.Struct({ channelName: Schema.String, attemptID: Schema.String })
export const WechatLoginSchema = Schema.Struct({
  attemptID: Schema.String,
  status: Schema.Literals([
    "starting",
    "wait",
    "scaned",
    "confirmed",
    "expired",
    "need_verifycode",
    "verify_code_blocked",
    "scaned_but_redirect",
    "binded_redirect",
    "cancelled",
  ]),
  qrContent: Schema.optional(Schema.String),
  expiresAt: Schema.Number,
  account: Schema.optional(
    Schema.Struct({ botId: Schema.String, baseUrl: Schema.String, scannerUserId: Schema.String }),
  ),
})
export const WechatStatusSchema = Schema.Struct({
  channelName: Schema.String,
  status: Schema.Literals([
    "unconfigured",
    "awaiting_login",
    "connected",
    "reconnecting",
    "auth_expired",
    "stopped",
    "account_busy",
  ]),
  botId: Schema.optional(Schema.String),
  lastReceivedAt: Schema.optional(Schema.Number),
  lastSentAt: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})

export const ImApi = HttpApi.make("im").add(
  HttpApiGroup.make("im")
    .add(
      HttpApiEndpoint.post("wechatLoginStart", `${root}/wechat/login/start`, {
        query: WorkspaceRoutingQuery,
        payload: WechatLoginPayload,
        success: described(WechatLoginSchema, "WeChat authorization attempt; contains no account credentials"),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "im.wechat.login.start", summary: "Start WeChat QR authorization" }),
      ),
      HttpApiEndpoint.post("wechatLoginPoll", `${root}/wechat/login/poll`, {
        query: WorkspaceRoutingQuery,
        payload: WechatPollPayload,
        success: WechatLoginSchema,
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "im.wechat.login.poll", summary: "Poll and complete WeChat authorization" }),
      ),
      HttpApiEndpoint.post("wechatLoginCancel", `${root}/wechat/login/cancel`, {
        query: WorkspaceRoutingQuery,
        payload: WechatCancelPayload,
        success: WechatLoginSchema,
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "im.wechat.login.cancel", summary: "Cancel WeChat authorization" }),
      ),
      HttpApiEndpoint.get("wechatStatus", `${root}/wechat/status`, {
        query: Schema.Struct({ ...WorkspaceRoutingQueryFields, channelName: Schema.String }),
        success: WechatStatusSchema,
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({ identifier: "im.wechat.status", summary: "Get WeChat channel connection state" }),
      ),
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
