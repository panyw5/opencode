import { Schema } from "effect"

const NonEmpty = Schema.String.check(Schema.isMinLength(1))

export const BackendConfig = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cli-json") }),
  Schema.Struct({ type: Schema.Literal("native-rpc") }),
  Schema.Struct({
    type: Schema.Literal("acp"),
    command: Schema.mutable(Schema.NonEmptyArray(NonEmpty)),
    managed: Schema.optional(
      Schema.Struct({
        advisor: Schema.Literals(["claude", "codex", "pi"]),
        version: NonEmpty,
      }),
    ),
    env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    model: Schema.optional(NonEmpty),
    mode: Schema.optional(NonEmpty),
    permission: Schema.optional(Schema.Literals(["deny", "ask"])),
  }),
])
export type BackendConfig = typeof BackendConfig.Type
export type AcpConfig = Extract<BackendConfig, { type: "acp" }>

export const AgentBackends = Schema.Struct({
  codex: Schema.optional(BackendConfig),
  claude: Schema.optional(BackendConfig),
  grok: Schema.optional(BackendConfig),
  dsh: Schema.optional(BackendConfig),
  pi: Schema.optional(BackendConfig),
})

export const AgentChannels = Schema.Struct({
  /** MCP servers forwarded to channel agents: all configured servers, an allow list, or none. */
  mcp: Schema.optional(Schema.Union([Schema.Literal("all"), Schema.Array(NonEmpty), Schema.Literal(false)])),
  idle_timeout_ms: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  max_processes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  timeout_ms: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
}).annotate({ identifier: "AgentChannels" })
export type AgentChannels = typeof AgentChannels.Type
