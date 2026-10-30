import path from "node:path"
import { homedir } from "node:os"
import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { PiRpcClient, object } from "@/pi/rpc"
import { PiTranscript } from "@/pi/transcript"
import { attachExternalTranscript } from "@/session/external"
import { which } from "@/util/which"
import { registerAdvisorIntervention } from "./advisor-intervention"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import DESCRIPTION from "./pi_consult.txt"

const log = Log.create({ service: "tool.pi_consult" })

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description: "Self-contained request for the local Pi advisor, including paths and constraints.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description: "Working directory; defaults to the current project. Must be an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Pi model selector, e.g. provider/model-id.",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: "Per-turn timeout in milliseconds, default 600000, maximum 1800000.",
  }),
})

export function buildPiArgs(model?: string) {
  const args = [
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--tools",
    "read,grep,find,ls",
  ]
  if (model?.trim()) args.push("--model", model.trim())
  return args
}

export const PiConsultTool = Tool.define(
  "pi_consult",
  Effect.gen(function* () {
    const configs = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.scoped(
          Effect.gen(function* () {
            const instance = yield* InstanceState.context
            const bridge = yield* EffectBridge.make()
            const config = (yield* configs.get()).pi
            if (config?.enabled === false) throw new Error("Pi integration is disabled")
            const prompt = params.prompt.trim()
            if (!prompt) throw new Error("prompt must be a non-empty string")
            const cwd = params.working_directory?.trim()
              ? path.resolve(instance.directory, params.working_directory.trim())
              : instance.directory
            log.info(`authorize session=${ctx.sessionID} cwd=${cwd}`)
            yield* ctx.ask({
              permission: "pi_consult",
              patterns: [cwd],
              always: ["*"],
              metadata: { working_directory: cwd, model: params.model },
            })
            yield* assertExternalDirectoryEffect(ctx, cwd, { kind: "directory" })
            const expand = (value: string) => (value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value)
            const executable = config?.binaryPath?.trim() || process.env.OPENCODE_PI_BIN?.trim() || which("pi")
            const binary = executable ? expand(executable) : undefined
            if (!binary)
              throw new Error(
                "Pi CLI not found. Install Pi or set its executable path in Settings > External agents > Pi.",
              )
            const timeout = Number.isFinite(params.timeout_ms)
              ? Math.min(1800000, Math.max(1000, Math.floor(params.timeout_ms!)))
              : 600000
            const home = config?.configHome?.trim() ? expand(config.configHome.trim()) : undefined
            const client = new PiRpcClient({
              binary,
              cwd,
              args: buildPiArgs(params.model),
              env: home ? { PI_CODING_AGENT_DIR: home } : undefined,
            })
            yield* Effect.addFinalizer(() => Effect.promise(() => client.stop()))
            const live = new PiTranscript()
            attachExternalTranscript(ctx, live)
            let sessionID: unknown
            let model = params.model ?? "default"
            let lastPublish = 0
            let publishing = Promise.resolve()
            let publicationError: unknown
            let closed = false
            let publishTimer: ReturnType<typeof setTimeout> | undefined
            const metadata = () => ({
              bin: binary,
              working_directory: cwd,
              model,
              session_id: sessionID,
              timeout_ms: timeout,
              tools: "read,grep,find,ls",
              safe_mode: true,
              preview: live.text.slice(-8000),
              transcript: live.transcript.slice(),
              intervention: intervention?.snapshot(),
            })
            const publish = () => ctx.metadata({ title: "Consulting Pi (read-only)", metadata: metadata() })
            const queuePublish = (force = false) => {
              if (closed) return
              if (!force && Date.now() - lastPublish < 120) {
                publishTimer ??= setTimeout(() => {
                  publishTimer = undefined
                  queuePublish(true)
                }, 120)
                return
              }
              clearTimeout(publishTimer)
              publishTimer = undefined
              lastPublish = Date.now()
              publishing = publishing
                .then(() => bridge.promise(publish()))
                .catch((error) => {
                  publicationError = error
                  log.warn(`publish failed session=${ctx.sessionID} error=${String(error)}`)
                })
            }
            const intervention = ctx.callID
              ? registerAdvisorIntervention({
                  sessionID: ctx.sessionID,
                  callID: ctx.callID,
                  advisor: "pi",
                  onChange: () => queuePublish(true),
                })
              : undefined
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true
                clearTimeout(publishTimer)
                intervention?.close()
              }),
            )
            const unlisten = client.onEvent((event) => {
              live.apply(event)
              queuePublish()
            })
            yield* Effect.addFinalizer(() => Effect.sync(unlisten))
            log.info(`start session=${ctx.sessionID} binary=${binary} cwd=${cwd} timeout=${timeout}`)
            const state = yield* Effect.promise(() => client.start(ctx.abort))
            const data = object(state.data)
            sessionID = data?.sessionId
            const selected = object(data?.model)
            if (selected?.id) model = `${selected.provider}/${selected.id}`
            yield* publish()
            const run = (message: string) =>
              Effect.gen(function* () {
                live.beginTurn()
                log.info(`prompt session=${ctx.sessionID} piSession=${sessionID} chars=${message.length}`)
                yield* Effect.promise(() => client.prompt(message, { signal: ctx.abort, timeoutMs: timeout }))
                yield* Effect.promise(() => publishing)
                if (publicationError) throw publicationError
                if (!live.text.trim()) throw new Error("Pi returned an empty response")
                yield* publish()
                log.info(`turn completed session=${ctx.sessionID} chars=${live.text.length}`)
              })
            yield* run(
              [
                "You are an external read-only advisor consulted by OpenCode. Analyze the request and give concrete recommendations. Do not modify files.",
                "",
                prompt,
              ].join("\n"),
            )
            while (intervention?.isActive()) {
              log.info(`waiting for intervention session=${ctx.sessionID}`)
              const command = yield* Effect.promise(() => intervention.wait(ctx.abort))
              if (command.type === "abort") throw new Error("Pi consultation was aborted")
              if (command.type !== "message") break
              intervention.setBusy(true)
              yield* run(command.message).pipe(Effect.ensuring(Effect.sync(() => intervention.setBusy(false))))
            }
            yield* Effect.promise(() => publishing)
            closed = true
            intervention?.close()
            log.info(`finished session=${ctx.sessionID} piSession=${sessionID}`)
            return {
              title: "Pi consultation",
              output: `<pi_consult>\nmodel: ${model}\nsession_id: ${sessionID ?? "unknown"}\n</pi_consult>\n\n${live.text}`,
              metadata: metadata(),
            }
          }),
        ).pipe(
          Effect.tapCause((cause) =>
            Effect.sync(() => log.warn(`failed session=${ctx.sessionID} cause=${String(cause)}`)),
          ),
          Effect.orDie,
        ),
    }
  }),
)
