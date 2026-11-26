import path from "path"
import { existsSync } from "node:fs"
import { Effect, Fiber, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./devin_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Config } from "@/config/config"
import { externalTurnFailure, resolveExternalAgentConfig, resolveExternalCli } from "./external-cli"
import { registerAdvisorIntervention } from "./advisor-intervention"
import { attachExternalTranscript, type TranscriptItem } from "@/session/external"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.devin_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 120
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_TRANSCRIPT_TEXT = 8_000

const PERMISSION_MODE = "dangerous"
const TOOL_ACCESS = "full"

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for local Devin. Include goal, absolute paths, constraints, and the exact form of answer you need. Devin cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory Devin should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Devin model override (passed to `devin --model`).",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type DevinConsultParams = Schema.Schema.Type<typeof Parameters>

export type DevinExecBuildInput = {
  prompt: string
  model?: string
  configPath?: string
}

export type DevinTranscriptItem = {
  id: string
  kind: "message" | "user" | "tool_use" | "tool_result" | "status" | "error" | "thinking"
  title?: string
  text?: string
  status?: string
}

export type DevinLiveState = {
  onTranscript?: (item: TranscriptItem) => void
  runSeq?: number
  sessionId?: string
  error?: string
  /** Accumulated plain-text stdout of the current `devin -p` run. */
  output: string
  transcript: DevinTranscriptItem[]
  preview?: string
}

export function createDevinLiveState(): DevinLiveState {
  return { output: "", transcript: [] }
}

function sharedArgs(input: { model?: string; configPath?: string }): string[] {
  const args = ["--permission-mode", PERMISSION_MODE, "--respect-workspace-trust", "false"]
  if (input.configPath) args.push("--config", input.configPath)
  if (input.model?.trim()) args.push("--model", input.model.trim())
  return args
}

/** Build argv for a full-access one-shot `devin -p` execution. */
export function buildDevinExecArgs(input: DevinExecBuildInput): string[] {
  const framed = [
    "You are an external implementation agent called by OpenCode.",
    "You may inspect and modify files, run terminal commands, and use network tools when needed.",
    "Work directly in the requested working directory. Verify important changes before responding.",
    "Return a concise summary of changes, verification, risks, and remaining work.",
    "Be concise and structured.",
    "",
    "Consultation request:",
    input.prompt,
  ].join("\n")

  return [...sharedArgs(input), "-p", framed]
}

/** Build argv to continue a Devin session for an intervention follow-up. */
export function buildDevinResumeArgs(input: {
  sessionId: string
  prompt: string
  model?: string
  configPath?: string
}): string[] {
  return [...sharedArgs(input), "-r", input.sessionId, "-p", input.prompt]
}

export function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)))
}

/** Pick the newest session id out of `devin list --format json` output. */
export function parseDevinSessionList(stdout: string): string | undefined {
  let list: unknown
  try {
    list = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  const items = list.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item),
  )
  const id = (item: Record<string, unknown>) =>
    [item.id, item.session_id, item.sessionId].find((value) => typeof value === "string" && value) as string | undefined
  const stamp = (item: Record<string, unknown>) => {
    for (const key of [
      "updated",
      "updated_at",
      "updatedAt",
      "last_active",
      "last_activity_at",
      "created",
      "created_at",
      "createdAt",
    ]) {
      const value = item[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
      if (typeof value === "string") {
        const time = Date.parse(value)
        if (!Number.isNaN(time)) return time
      }
    }
    return undefined
  }
  const sorted = [...items].sort((a, b) => (stamp(b) ?? 0) - (stamp(a) ?? 0))
  for (const item of sorted) {
    const found = id(item)
    if (found) return found
  }
  return undefined
}

export const DevinConsultTool = Tool.define(
  "devin_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const configs = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: DevinConsultParams, ctx: Tool.Context) => {
        let intervention: ReturnType<typeof registerAdvisorIntervention> | undefined
        return Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)

          yield* ctx.ask({
            permission: "devin_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              model: params.model,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })

          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const agentConfig = (yield* configs.get()).external_agents?.devin
          const explicitHome = resolveExternalAgentConfig("devin", agentConfig).configHome
          const runtime = resolveExternalCli("devin", agentConfig)
          const bin = runtime.binary
          // Devin has no config-dir env var; map the configured home to --config.
          const configPath =
            explicitHome || existsSync(path.join(runtime.home, "config.json"))
              ? path.join(runtime.home, "config.json")
              : undefined
          log.info("runtime resolved advisor=devin binary=" + bin + " home=" + runtime.home)

          const prompt = params.prompt.trim()
          if (!prompt) {
            throw new Error("prompt must be a non-empty string")
          }

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const args = buildDevinExecArgs({ prompt, model: params.model, configPath })

          const live = createDevinLiveState()
          attachExternalTranscript(ctx, live)
          let lastMetaAt = 0

          const publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              yield* ctx.metadata({
                title: live.preview ? `Devin: ${clip(live.preview, 80).replace(/\s+/g, " ")}` : "Running Devin",
                metadata: {
                  bin,
                  config_home: runtime.home,
                  working_directory: workingDirectory,
                  model: params.model,
                  timeout_ms: timeoutMs,
                  tools: TOOL_ACCESS,
                  permission_mode: PERMISSION_MODE,
                  prompt,
                  session_id: live.sessionId,
                  preview: live.preview,
                  transcript: live.transcript.slice(),
                  intervention: intervention?.snapshot(),
                },
              })
            })

          intervention = ctx.callID
            ? registerAdvisorIntervention({
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                advisor: "devin",
                onChange: () => void Effect.runPromise(publishMetadata(true)),
              })
            : undefined

          yield* publishMetadata(true)

          log.info("starting devin consult", {
            bin,
            cwd: workingDirectory,
            model: params.model,
            timeoutMs,
            argCount: args.length,
            promptLength: prompt.length,
          })

          const runProcess = (runArgs: string[]) =>
            Effect.scoped(
              Effect.gen(function* () {
                live.error = undefined
                live.output = ""
                live.runSeq = (live.runSeq ?? 0) + 1
                const messageID = `message:${live.runSeq}`
                const handle = yield* spawner.spawn(
                  ChildProcess.make(bin, runArgs, {
                    cwd: workingDirectory,
                    extendEnv: true,
                    env: runtime.env,
                    stdin: "ignore",
                  }),
                )
                upsertTranscript(live, {
                  id: messageID,
                  kind: "message",
                  title: "Assistant",
                  text: "",
                  status: "running",
                })

                let stderr = ""
                const stdoutFiber = yield* Effect.forkScoped(
                  Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                    Effect.gen(function* () {
                      live.output += chunk
                      if (live.output.trim()) live.preview = live.output.trim()
                      upsertTranscript(live, {
                        id: messageID,
                        kind: "message",
                        title: "Assistant",
                        text: live.onTranscript ? live.output : clip(live.output, MAX_TRANSCRIPT_TEXT),
                        status: "running",
                      })
                      yield* publishMetadata()
                    }),
                  ),
                )
                const stderrFiber = yield* Effect.forkScoped(
                  Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
                    Effect.sync(() => {
                      stderr += chunk
                    }),
                  ),
                )

                const abort = Effect.callback<void>((resume) => {
                  if (ctx.abort.aborted) return resume(Effect.void)
                  const handler = () => resume(Effect.void)
                  ctx.abort.addEventListener("abort", handler, { once: true })
                  return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
                })

                const timeout = Effect.sleep(`${timeoutMs} millis`)

                const exit = yield* Effect.raceAll([
                  handle.exitCode.pipe(
                    Effect.map((code) => ({ kind: "exit" as const, code: Number(code) })),
                    Effect.orDie,
                  ),
                  abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null as number | null }))),
                  timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null as number | null }))),
                ])

                if (exit.kind === "abort" || exit.kind === "timeout") {
                  yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
                }

                // Process exit can win the race before stdout's final chunk is consumed.
                yield* Fiber.join(stdoutFiber).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.orElseSucceed(() => void 0),
                )
                yield* Fiber.join(stderrFiber).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.orElseSucceed(() => void 0),
                )

                upsertTranscript(live, {
                  id: messageID,
                  kind: "message",
                  title: "Assistant",
                  text: live.onTranscript ? live.output : clip(live.output, MAX_TRANSCRIPT_TEXT),
                  status: exit.kind === "exit" && exit.code === 0 ? "completed" : "error",
                })
                yield* publishMetadata(true)

                log.info("devin process finished", {
                  kind: exit.kind,
                  code: exit.code,
                  stdoutLength: live.output.length,
                  stderrLength: stderr.length,
                  stderrPreview: stripAnsi(stderr).trim().slice(0, 500),
                  sessionId: live.sessionId,
                })

                return { exit, stdout: live.output, stderr }
              }),
            ).pipe(Effect.orDie)

          // `devin -p` prints plain text, so the session id is recovered from
          // `devin list --format json` after the run for intervention resumes.
          const discoverSession = () =>
            Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* spawner.spawn(
                  ChildProcess.make(bin, ["list", "--format", "json"], {
                    cwd: workingDirectory,
                    extendEnv: true,
                    env: runtime.env,
                    stdin: "ignore",
                  }),
                )
                let stdout = ""
                yield* Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                  Effect.sync(() => {
                    stdout += chunk
                  }),
                )
                const stderrFiber = yield* Effect.forkScoped(
                  Stream.runForEach(Stream.decodeText(handle.stderr), () => Effect.void),
                )
                yield* handle.exitCode.pipe(Effect.orDie)
                yield* Fiber.join(stderrFiber).pipe(
                  Effect.timeout("5 seconds"),
                  Effect.orElseSucceed(() => void 0),
                )
                return parseDevinSessionList(stdout)
              }),
            ).pipe(Effect.catch(() => Effect.succeed(undefined)))

          let result = yield* runProcess(args)

          if (result.exit.kind === "abort") {
            upsertTranscript(live, {
              id: `aborted:${Date.now()}`,
              kind: "status",
              title: "Stopped",
              text: "Devin consultation was aborted",
            })
            yield* publishMetadata(true)
            throw new Error("Devin consultation was aborted")
          }
          if (result.exit.kind === "timeout") {
            throw new Error(`Devin consultation timed out after ${timeoutMs}ms`)
          }

          live.sessionId ??= yield* discoverSession()
          const exitCode = result.exit.code
          let sessionId = live.sessionId
          const transcript = live.transcript
          const body = result.stdout.trim()
          const failure = externalTurnFailure({
            advisor: "Devin",
            exitCode,
            completed: true,
            answer: body,
            stderr: result.stderr,
          })
          log.info("turn validated advisor=devin success=" + !failure + " exit=" + exitCode)
          if (failure) throw new Error(failure)
          let answer = body

          const started = intervention?.isActive() ?? false
          const activeIntervention = intervention
          while (started && activeIntervention?.isActive()) {
            const command = yield* Effect.promise(() => activeIntervention.wait(ctx.abort))
            if (command.type === "abort") throw new Error("Devin consultation was aborted")
            if (command.type !== "message") break
            if (!sessionId) throw new Error("Devin did not return a session id for intervention")
            upsertTranscript(live, {
              id: `intervention-user:${Date.now()}`,
              kind: "user",
              title: "User",
              text: command.message,
              status: "completed",
            })
            activeIntervention.setBusy(true)
            try {
              result = yield* runProcess(
                buildDevinResumeArgs({
                  sessionId,
                  prompt: command.message,
                  model: params.model,
                  configPath,
                }),
              )
            } finally {
              activeIntervention.setBusy(false)
              yield* publishMetadata(true)
            }
            if (result.exit.kind === "abort") throw new Error("Devin consultation was aborted")
            if (result.exit.kind === "timeout") throw new Error(`Devin consultation timed out after ${timeoutMs}ms`)
            const nextBody = result.stdout.trim()
            const nextError = externalTurnFailure({
              advisor: "Devin",
              exitCode: result.exit.code,
              completed: true,
              answer: nextBody,
              stderr: result.stderr,
            })
            log.info("followup validated advisor=devin success=" + !nextError + " exit=" + result.exit.code)
            if (nextError) {
              upsertTranscript(live, {
                id: `intervention-error:${Date.now()}`,
                kind: "error",
                title: "Error",
                text: nextError,
                status: "error",
              })
              yield* publishMetadata(true)
              continue
            }
            answer = nextBody
            yield* publishMetadata(true)
          }

          intervention?.close()
          const header = [
            "<devin_consult>",
            "tools: full",
            `permission_mode: ${PERMISSION_MODE}`,
            `working_directory: ${workingDirectory}`,
            sessionId ? `session_id: ${sessionId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            "</devin_consult>",
          ]
            .filter(Boolean)
            .join("\n")
          return {
            title: "Devin execution",
            output: `${header}\n\n${answer}`,
            metadata: {
              tools: TOOL_ACCESS,
              permission_mode: PERMISSION_MODE,
              working_directory: workingDirectory,
              prompt,
              session_id: sessionId,
              config_home: runtime.home,
              model: params.model,
              exit_code: result.exit.code,
              preview: answer,
              transcript,
            },
          }
        }).pipe(Effect.ensuring(Effect.sync(() => intervention?.close())))
      },
    }
  }),
)

function upsertTranscript(state: DevinLiveState, item: DevinTranscriptItem) {
  state.onTranscript?.({ ...item, id: `${state.runSeq ?? 0}:${item.id}` })
  item = { ...item, text: item.text === undefined ? undefined : clip(item.text, MAX_TRANSCRIPT_TEXT) }
  const index = state.transcript.findIndex((entry) => entry.id === item.id)
  if (index >= 0) state.transcript[index] = { ...state.transcript[index], ...item }
  else {
    state.transcript.push(item)
    if (state.transcript.length > MAX_TRANSCRIPT_ITEMS)
      state.transcript.splice(0, state.transcript.length - MAX_TRANSCRIPT_ITEMS)
  }
}

function resolveWorkingDirectory(input: string | undefined, projectDirectory: string): string {
  if (!input?.trim()) return projectDirectory
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(projectDirectory, input)
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "")
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`
}
