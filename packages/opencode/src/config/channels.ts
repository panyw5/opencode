import { Schema } from "effect"

/** Shared optional fields for every IM channel type. */
const ChannelCommon = {
  directory: Schema.optional(Schema.String).annotate({
    description:
      "Working directory for this channel's sessions and agent tools. Decoupled from OpenCode projects. Defaults to {config}/channels/{channelName} (e.g. ~/.config/opencode/channels/work-feishu).",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Whether this channel is intended to be enabled. Defaults to true.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Model for IM conversations on this channel, as provider/model (e.g. anthropic/claude-sonnet-4).",
  }),
}

export const Feishu = Schema.Struct({
  type: Schema.Literal("feishu").annotate({ description: "Feishu / Lark IM channel" }),
  appId: Schema.String.annotate({ description: "Feishu App ID (cli_xxx)" }),
  appSecret: Schema.String.annotate({ description: "Feishu App Secret" }),
  allowedUsers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Allowed user open_ids. Empty or containing '*' means unrestricted.",
  }),
  domain: Schema.optional(Schema.Literals(["feishu", "lark"])).annotate({
    description: "API domain: feishu (China) or lark (international). Defaults to feishu.",
  }),
  ...ChannelCommon,
}).annotate({ identifier: "ChannelFeishuConfig" })
export type Feishu = Schema.Schema.Type<typeof Feishu>

export const Discord = Schema.Struct({
  type: Schema.Literal("discord").annotate({ description: "Discord IM channel" }),
  botToken: Schema.String.annotate({ description: "Discord bot token" }),
  allowedUsers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Allowed Discord user IDs. Empty or containing '*' means unrestricted.",
  }),
  proxy: Schema.optional(Schema.String).annotate({
    description: "Optional HTTP(S) proxy URL for Discord gateway / API",
  }),
  ...ChannelCommon,
}).annotate({ identifier: "ChannelDiscordConfig" })
export type Discord = Schema.Schema.Type<typeof Discord>

export const QQ = Schema.Struct({
  type: Schema.Literal("qq").annotate({ description: "QQ bot via OneBot 11 WebSocket" }),
  endpoint: Schema.String.annotate({ description: "OneBot 11 WebSocket endpoint (ws:// or wss://)" }),
  accessToken: Schema.optional(Schema.String).annotate({ description: "Optional OneBot access token" }),
  allowedUsers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Allowed QQ user IDs. Empty or containing '*' means unrestricted.",
  }),
  groupRequireMention: Schema.optional(Schema.Boolean).annotate({
    description: "Only respond to group messages mentioning the bot. Defaults to false.",
  }),
  ...ChannelCommon,
}).annotate({ identifier: "ChannelQQConfig" })
export type QQ = Schema.Schema.Type<typeof QQ>

export const Info = Schema.Union([Feishu, Discord, QQ]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigChannels from "./channels"
