import { Schema } from "effect"
import { MessageID, PartID } from "./schema"

export const Advisor = Schema.Literals(["codex", "claude", "grok", "dsh", "pi"])
export type Advisor = typeof Advisor.Type

export const ExternalSession = Schema.Struct({
  advisor: Advisor,
  sourceMessageID: MessageID,
  sourcePartID: PartID,
  callID: Schema.String,
  historical: Schema.Boolean,
  ownerPID: Schema.optional(Schema.Int),
}).annotate({ identifier: "ExternalSession" })
export type ExternalSession = typeof ExternalSession.Type

export const ExternalSessionState = Schema.Struct({
  available: Schema.Boolean,
  active: Schema.Boolean,
  busy: Schema.Boolean,
  queued: Schema.Boolean,
  waitingForInput: Schema.Boolean,
  stopping: Schema.Boolean,
}).annotate({ identifier: "ExternalSessionState" })
export type ExternalSessionState = typeof ExternalSessionState.Type
