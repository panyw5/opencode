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

export const ChannelOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

export const ChannelOptions = Schema.Struct({
  advisor: Advisor,
  model: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  models: Schema.Array(ChannelOption),
  modes: Schema.Array(ChannelOption),
}).annotate({ identifier: "ChannelOptions" })
export type ChannelOptions = Schema.Schema.Type<typeof ChannelOptions>

export const ChannelUpdateInput = Schema.Struct({
  model: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
}).annotate({ identifier: "ChannelUpdateInput" })
export type ChannelUpdateInput = Schema.Schema.Type<typeof ChannelUpdateInput>

/** An existing agent-side session returned by ACP session/list. */
export const AgentSession = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  cwd: Schema.String,
  updated: Schema.optional(Schema.String),
}).annotate({ identifier: "AgentSession" })
export type AgentSession = Schema.Schema.Type<typeof AgentSession>

export const AgentSessionList = Schema.Struct({
  /** False when the agent does not advertise the ACP session/list capability. */
  supported: Schema.Boolean,
  /** Whether the agent advertises session/load — required to actually attach a listed session. */
  loadable: Schema.Boolean,
  sessions: Schema.Array(AgentSession),
}).annotate({ identifier: "AgentSessionList" })
export type AgentSessionList = Schema.Schema.Type<typeof AgentSessionList>
