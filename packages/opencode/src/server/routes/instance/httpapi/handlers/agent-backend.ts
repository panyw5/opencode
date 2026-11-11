import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { AgentInstallError, managedAgents } from "@/agent-backend/install"
import { probeAdapter, probeChannelOptions } from "@/agent-backend/probe"
import type { ChannelOptions } from "@/session/channel-schema"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, ConflictError, UpstreamError, ForbiddenError } from "../errors"

const CHANNEL_OPTIONS_TTL_MS = 5 * 60 * 1000
const channelOptionsCache = new Map<string, { at: number; value: ChannelOptions }>()

const mapped = (error: unknown) =>
  error instanceof AgentInstallError
    ? error.kind === "busy"
      ? new ConflictError({ message: error.message })
      : new InvalidRequestError({ message: error.message })
    : new UpstreamError({ message: String(error).slice(0, 3000), service: "agent-backend" })

export const agentBackendHandlers = HttpApiBuilder.group(InstanceHttpApi, "agentBackend", (handlers) =>
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const config = yield* Config.Service
    const allowed = () =>
      flags.pure
        ? Effect.fail(new ForbiddenError({ message: "Adapter management is disabled in pure mode" }))
        : Effect.void
    const manager = managedAgents()
    const run = <T>(fn: (signal: AbortSignal) => Promise<T>) =>
      allowed().pipe(Effect.andThen(Effect.tryPromise({ try: fn, catch: mapped })))
    return handlers
      .handle("status", () => run(() => manager.status()))
      .handle("prepare", (ctx) => run(async () => manager.prepare(ctx.payload)))
      .handle("commit", (ctx) =>
        run((signal) => manager.commit(ctx.payload.token, AbortSignal.any([signal, AbortSignal.timeout(300000)]))),
      )
      .handle("probe", (ctx) =>
        Effect.gen(function* () {
          if (ctx.payload.config.type !== "acp")
            return yield* new InvalidRequestError({ message: "Choose an ACP backend before testing" })
          const probeConfig = ctx.payload.config
          const cwd = yield* InstanceState.directory
          return yield* run((signal) => probeAdapter({ ...ctx.payload, config: probeConfig, cwd, signal }))
        }),
      )
      .handle("channelOptions", (ctx) =>
        Effect.gen(function* () {
          const info = yield* config.get()
          const selection = info.agent_backends?.[ctx.payload.advisor]
          if (!selection || selection.type !== "acp")
            return yield* new InvalidRequestError({
              message: `${ctx.payload.advisor} is not configured for ACP`,
            })
          const cwd = yield* InstanceState.directory
          const key = `${cwd}\n${ctx.payload.advisor}`
          const cached = channelOptionsCache.get(key)
          if (cached && Date.now() - cached.at < CHANNEL_OPTIONS_TTL_MS) return cached.value
          const value = yield* run((signal) =>
            probeChannelOptions(
              {
                advisor: ctx.payload.advisor,
                config: selection,
                cwd,
                signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
              },
              manager,
            ),
          )
          channelOptionsCache.set(key, { at: Date.now(), value })
          return value
        }),
      )
  }),
)
