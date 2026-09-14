import { Schema } from "effect"
import { createHash } from "node:crypto"

export const Platform = Schema.Literals(["feishu", "qq"])
export type Platform = Schema.Schema.Type<typeof Platform>

export const TargetScope = Schema.Literals(["chat", "c2c", "group", "guild"])
export type TargetScope = Schema.Schema.Type<typeof TargetScope>

/** Normalized destination shared by channel adapters and IM tools. */
export class Target extends Schema.Class<Target>("IMTarget")({
  platform: Platform,
  channelName: Schema.String,
  scope: TargetScope,
  conversationID: Schema.String,
  senderID: Schema.optional(Schema.String),
  replyTo: Schema.optional(Schema.String),
}) {}

export const SendMode = Schema.Literals(["reply", "proactive"])
export type SendMode = Schema.Schema.Type<typeof SendMode>

export const Capability = Schema.Literals(["supported", "limited", "unsupported"])
export type Capability = Schema.Schema.Type<typeof Capability>

export class Capabilities extends Schema.Class<Capabilities>("IMCapabilities")({
  passiveReply: Schema.Boolean,
  proactiveC2C: Capability,
  proactiveGroup: Capability,
  proactiveGuild: Capability,
}) {}

export class NormalizedMessage extends Schema.Class<NormalizedMessage>("IMNormalizedMessage")({
  id: Schema.String,
  platform: Platform,
  channelName: Schema.String,
  eventID: Schema.String,
  target: Target,
  senderID: Schema.optional(Schema.String),
  senderName: Schema.optional(Schema.String),
  text: Schema.String,
  timeEvent: Schema.optional(Schema.Number),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export type TransportSendInput = {
  target: Target
  text: string
  mode: SendMode
  providerSequence?: number
}

export type TransportSendResult = {
  providerMessageID?: string
  timeSent: number
}

export type IMTransport = {
  readonly platform: Platform
  readonly channelName: string
  readonly capabilities: Capabilities
  readonly sendText: (input: TransportSendInput) => Promise<TransportSendResult>
}

export function proactiveCapability(capabilities: Capabilities, scope: TargetScope): Capability {
  if (scope === "c2c") return capabilities.proactiveC2C
  if (scope === "group") return capabilities.proactiveGroup
  return capabilities.proactiveGuild
}

export function isTargetScopeSupported(platform: Platform, scope: TargetScope): boolean {
  return platform === "feishu" ? scope === "chat" : scope === "c2c" || scope === "group" || scope === "guild"
}

export function messageRecordID(platform: Platform, channelName: string, eventID: string): string {
  // Event IDs are provider-controlled and may contain arbitrary punctuation.
  // Keep the durable ID short and deterministic without persisting credentials.
  const hash = createHash("sha256").update(`${platform}\0${channelName}\0${eventID}`).digest("hex").slice(0, 24)
  return `im_${hash}`
}

export * as IMModel from "./model"
