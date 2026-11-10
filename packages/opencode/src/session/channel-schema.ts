import { Schema } from "effect"
import { Advisor } from "./external-schema"

/**
 * A session-level external agent channel. The session's prompts are executed by
 * an ACP agent instead of the native provider loop.
 */
export const SessionChannel = Schema.Struct({
  kind: Schema.Literal("acp"),
  advisor: Advisor,
  /** ACP-side model id. The external agent owns model selection. */
  model: Schema.optional(Schema.String),
  /** ACP session mode (plan/code/...), distinct from OpenCode's agent concept. */
  mode: Schema.optional(Schema.String),
  /** Agent-side session id used to resume with session/load. */
  acpSessionID: Schema.optional(Schema.String),
}).annotate({ identifier: "SessionChannel" })
export type SessionChannel = Schema.Schema.Type<typeof SessionChannel>
