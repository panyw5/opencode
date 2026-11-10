import path from "node:path"
import { Effect, Fiber } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { attachExternalTranscript } from "@/session/external"
import { registerAdvisorIntervention } from "@/tool/advisor-intervention"
import { assertExternalDirectoryEffect } from "@/tool/external-directory"
import type { Advisor } from "@/session/external-schema"
import type { AgentBackend } from "./backend"
import type { AcpConfig } from "./schema"
import { AcpAgentClient } from "./acp-client"
import { AcpTranscript } from "./acp-transcript"

const log = Log.create({ service: "agent-backend" })

export function acpBackend(advisor: Advisor, config: AcpConfig): AgentBackend {
  return {
    advisor,
    kind: "acp",
    execute: (input, ctx) =>
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const bridge = yield* EffectBridge.make()
          const prompt = input.prompt.trim()
          if (!prompt) throw new Error("prompt must be a non-empty string")
          const cwd = path.resolve(instance.directory, input.working_directory?.trim() || ".")
          const timeout = Number.isFinite(input.timeout_ms)
            ? Math.min(1800000, Math.max(1000, Math.floor(input.timeout_ms!)))
            : 600000
          log.info(`authorize advisor=${advisor} backend=acp session=${ctx.sessionID} cwd=${cwd}`)
          yield* ctx.ask({
            permission: `${advisor}_consult`,
            patterns: [cwd],
            always: ["*"],
            metadata: { backend: "acp", command: config.command, working_directory: cwd },
          })
          yield* assertExternalDirectoryEffect(ctx, cwd, { kind: "directory" })
          const live = new AcpTranscript()
          attachExternalTranscript(ctx, live)
          let closed = false
          let publishing = Promise.resolve()
          let publicationError: unknown
          let timer: ReturnType<typeof setTimeout> | undefined
          const intervention = ctx.callID
            ? registerAdvisorIntervention({
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                advisor,
                onChange: () => queuePublish(),
              })
            : undefined
          const metadata = () => ({
            backend: "acp",
            working_directory: cwd,
            session_id: client.sessionID,
            model: client.model ?? input.model ?? config.model ?? "default",
            timeout_ms: timeout,
            permission: config.permission ?? "deny",
            capabilities: client.capabilities,
            preview: live.text.slice(-8000),
            transcript: live.transcript.slice(-80),
            intervention: intervention?.snapshot(),
          })
          const publish = () => ctx.metadata({ title: `Consulting ${advisor} (ACP)`, metadata: metadata() })
          const queuePublish = () => {
            if (closed || timer) return
            timer = setTimeout(() => {
              timer = undefined
              publishing = publishing
                .then(() => bridge.promise(publish()))
                .catch((error) => {
                  publicationError = error
                  log.warn(`publication failed advisor=${advisor} error=${String(error)}`)
                })
            }, 120)
          }
          const client = new AcpAgentClient({
            config,
            cwd,
            model: input.model?.trim() || undefined,
            onEvent: (event) => {
              live.apply(event)
              queuePublish()
            },
            requestPermission: async (request, signal) => {
              log.info(
                `permission advisor=${advisor} session=${request.sessionId} tool=${request.toolCall.toolCallId} policy=${config.permission ?? "deny"}`,
              )
              const cancelled = { outcome: { outcome: "cancelled" as const } }
              if (signal.aborted || ctx.abort.aborted || request.sessionId !== client.sessionID) return cancelled
              const reject = request.options.find((item) => item.kind === "reject_once")
              const deny = () =>
                reject ? { outcome: { outcome: "selected" as const, optionId: reject.optionId } } : cancelled
              // Never choose allow_always: remembered decisions belong to the agent.
              const allow = request.options.find((item) => item.kind === "allow_once")
              if (config.permission !== "ask" || !allow) return deny()
              try {
                const fiber = bridge.fork(
                  ctx.ask({
                    permission: "external_agent_tool",
                    patterns: request.toolCall.locations?.length
                      ? request.toolCall.locations.map((item) => item.path)
                      : [request.toolCall.toolCallId],
                    always: [],
                    metadata: { advisor, backend: "acp", toolCall: request.toolCall },
                  }),
                )
                const abort = () => {
                  bridge.fork(Fiber.interrupt(fiber))
                }
                signal.addEventListener("abort", abort, { once: true })
                if (signal.aborted) abort()
                try {
                  await bridge.promise(Fiber.join(fiber))
                } finally {
                  signal.removeEventListener("abort", abort)
                }
                if (signal.aborted || ctx.abort.aborted) return cancelled
                return { outcome: { outcome: "selected", optionId: allow.optionId } }
              } catch (error) {
                log.info(`permission rejected advisor=${advisor} error=${String(error)}`)
                return signal.aborted || ctx.abort.aborted ? cancelled : deny()
              }
            },
          })
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              closed = true
              clearTimeout(timer)
              intervention?.close()
              await client.stop()
              await publishing
            }),
          )
          yield* Effect.promise(() => client.start(ctx.abort))
          const run = (message: string) =>
            Effect.gen(function* () {
              live.beginTurn(message)
              const response = yield* Effect.promise(() => client.prompt(message, ctx.abort, timeout)).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    clearTimeout(timer)
                    timer = undefined
                    yield* Effect.promise(() => publishing)
                    yield* publish()
                  }),
                ),
              )
              if (response.stopReason !== "end_turn") throw new Error(`ACP turn stopped: ${response.stopReason}`)
              if (publicationError) throw publicationError
              if (!live.text.trim()) throw new Error("ACP agent returned an empty response")
            })
          yield* run(`You are an external advisor consulted by OpenCode. Do not modify files.\n\n${prompt}`)
          while (intervention?.isActive()) {
            log.info(`waiting advisor=${advisor} backend=acp session=${client.sessionID}`)
            const command = yield* Effect.promise(() => intervention.wait(ctx.abort))
            if (command.type === "abort") throw new Error("ACP consultation aborted")
            if (command.type !== "message") break
            intervention.setBusy(true)
            yield* run(command.message).pipe(Effect.ensuring(Effect.sync(() => intervention.setBusy(false))))
          }
          log.info(`finished advisor=${advisor} backend=acp session=${client.sessionID} chars=${live.text.length}`)
          return { title: `${advisor} consultation (ACP)`, output: live.text, metadata: metadata() }
        }),
      ).pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => log.warn(`failed advisor=${advisor} backend=acp cause=${String(cause)}`)),
        ),
        Effect.orDie,
      ),
  }
}
