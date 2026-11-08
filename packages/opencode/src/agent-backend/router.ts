import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { Config } from "@/config/config"
import type { Advisor } from "@/session/external-schema"
import * as Tool from "@/tool/tool"
import { resolveExternalAgentConfig } from "@/tool/external-cli"
import { acpBackend } from "./acp"
import { legacyBackend, type AgentInput } from "./backend"
import { managedAgents } from "./install"

const log = Log.create({ service: "agent-backend.router" })

/** Route before transcript projection so all transports share one child-session/UI path. */
export function routeAgentBackend<P extends Schema.Decoder<AgentInput>>(
  advisor: Advisor,
  tool: Tool.Def<P>,
  configs: Pick<Config.Interface, "get">,
): Tool.Def<P> {
  const legacy = legacyBackend<Schema.Schema.Type<P>>(advisor, tool.execute)
  const decode = Schema.decodeUnknownEffect(tool.parameters)
  return {
    ...tool,
    execute: (input, ctx) =>
      Effect.gen(function* () {
        const decoded = yield* decode(input).pipe(
          Effect.mapError(
            (error) =>
              new Tool.InvalidArgumentsError({
                tool: tool.id,
                detail: String(error),
              }),
          ),
          Effect.orDie,
        )
        const config = yield* configs.get()
        const local =
          advisor === "pi" ? config.pi : resolveExternalAgentConfig(advisor, config.external_agents?.[advisor])
        if (local?.enabled === false) throw new Error(`${advisor} integration is disabled`)
        const selection = config.agent_backends?.[advisor]
        if (selection && selection.type !== "acp" && selection.type !== legacy.kind)
          throw new Error(`${advisor} does not support backend ${selection.type}; use ${legacy.kind} or acp`)
        if (selection?.type === "acp" && advisor === "dsh") {
          // DSH-specific execution controls must never be silently discarded by ACP.
          const extra = Object.keys(decoded).filter(
            (key) => !["prompt", "working_directory", "model", "timeout_ms"].includes(key),
          )
          if (extra.length)
            throw new Error(`DSH ACP backend does not accept CLI-specific parameters: ${extra.join(", ")}`)
        }
        const managed = selection?.type === "acp" ? selection.managed : undefined
        if (managed && managed.advisor !== advisor)
          throw new Error("Managed adapter does not match the selected advisor")
        const lease = managed
          ? yield* Effect.promise(() => managedAgents().acquire(managed.advisor, managed.version))
          : undefined
        if (lease) yield* Effect.addFinalizer(() => Effect.promise(lease.release))
        const backend =
          selection?.type === "acp"
            ? acpBackend(advisor, {
                ...selection,
                command: lease ? (lease.command as [string, ...string[]]) : selection.command,
              })
            : legacy
        log.info(`selected advisor=${advisor} backend=${backend.kind} session=${ctx.sessionID}`)
        const context: Tool.Context = {
          ...ctx,
          metadata: (value) => ctx.metadata({ ...value, metadata: { ...value.metadata, backend: backend.kind } }),
        }
        const result = yield* backend.execute(decoded as Schema.Schema.Type<P>, context)
        log.info(`completed advisor=${advisor} backend=${backend.kind} session=${ctx.sessionID}`)
        return { ...result, metadata: { ...result.metadata, backend: backend.kind } }
      }).pipe(
        Effect.scoped,
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            log.warn(`failed advisor=${advisor} session=${ctx.sessionID} cause=${String(cause)}`)
          }),
        ),
        Effect.orDie,
      ),
  }
}
