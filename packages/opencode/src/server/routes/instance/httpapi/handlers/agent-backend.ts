import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { AgentInstallError, managedAgents } from "@/agent-backend/install"
import { probeAdapter } from "@/agent-backend/probe"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, ConflictError, UpstreamError, ForbiddenError } from "../errors"

const mapped = (error: unknown) =>
  error instanceof AgentInstallError
    ? error.kind === "busy"
      ? new ConflictError({ message: error.message })
      : new InvalidRequestError({ message: error.message })
    : new UpstreamError({ message: String(error).slice(0, 3000), service: "agent-backend" })

export const agentBackendHandlers = HttpApiBuilder.group(InstanceHttpApi, "agentBackend", (handlers) =>
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
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
          const config = ctx.payload.config
          const cwd = yield* InstanceState.directory
          return yield* run((signal) => probeAdapter({ ...ctx.payload, config, cwd, signal }))
        }),
      )
  }),
)
