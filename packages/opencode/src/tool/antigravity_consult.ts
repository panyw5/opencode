import path from "path"
import { Effect, Fiber, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./antigravity_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Config } from "@/config/config"
import { externalTurnFailure, resolveExternalCli } from "./external-cli"
import { registerAdvisorIntervention } from "./advisor-intervention"
import { attachExternalTranscript, type TranscriptItem } from "@/session/external"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.antigravity_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 120
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_TRANSCRIPT_TEXT = 8_000

const PERMISSION_MODE = "dangerously-skip-permissions"
const TOOL_ACCESS = "full"

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for local Antigravity. Include goal, absolute paths, constraints, and the exact form of answer you need. Antigravity cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory Antigravity should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Antigravity model override (passed to `agy --model`).",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type AntigravityConsultParams = Schema.Schema.Type<typeof Parameters>

export type AntigravityExecBuildInput = {
  prompt: string
  workingDirectory: string
  model?: string
}

export function buildAntigravityResumeArgs(input: { sessionId: string; prompt: string; model?: string }): string[] {
  const args = [
    "--conversation",
    input.sessionId,
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  return args
}

export type AntigravityTranscriptItem = {
  id: string
  kind: "message" | "user" | "tool_use" | "tool_result" | "status" | "error" | "thinking"
  title?: string
  text?: string
  status?: string
}

export type AntigravityLiveState = {
  completed?: boolean
  onTranscript?: (item: TranscriptItem) => void
  runSeq?: number
  sessionId?: string
  usage?: Record<string, unknown>
  durationMs?: number
  error?: string
  agentMessages: string[]
  transcript: AntigravityTranscriptItem[]
  preview?: string
  /** Accumulated text_delta per step_index; transcript text is clipped so it cannot be reused. */
  steps: Map<number, string>
}

/** Build argv for a full-access one-shot `agy -p` execution. */
export function buildAntigravityExecArgs(input: AntigravityExecBuildInput): string[] {
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

  const args = ["-p", framed, "--output-format", "stream-json", "--dangerously-skip-permissions"]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  return args
}

export type AntigravityJsonlParseResult = {
  completed?: boolean
  finalResponse: string
  sessionId?: string
  usage?: AntigravityLiveState["usage"]
  durationMs?: number
  error?: string
  agentMessages: string[]
  transcript: AntigravityTranscriptItem[]
  preview?: string
}

export function createAntigravityLiveState(): AntigravityLiveState {
  return { agentMessages: [], transcript: [], steps: new Map() }
}

/** Apply one `agy -p --output-format stream-json` JSONL event into live state. */
export function applyAntigravityJsonlLine(state: AntigravityLiveState, rawLine: string): boolean {
  const line = rawLine.trim()
  if (!line) return false
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return false
  }
  if (!event || typeof event !== "object") return false
  const e = event as Record<string, unknown>
  const type = typeof e.event === "string" ? e.event : ""

  const conversationId = typeof e.conversation_id === "string" ? e.conversation_id : undefined
  if (conversationId && state.sessionId !== conversationId) state.sessionId = conversationId

  if (type === "init") {
    upsertTranscript(state, {
      id: `init:${state.sessionId ?? state.transcript.length}`,
      kind: "status",
      title: "Session started",
      text: state.sessionId,
    })
    return true
  }

  if (type === "step_update") {
    const step = readObject(e.step_update)
    if (!step) return false
    const stepConversation = typeof step.conversation_id === "string" ? step.conversation_id : undefined
    if (stepConversation && state.sessionId !== stepConversation) state.sessionId = stepConversation
    const index = typeof step.step_index === "number" ? step.step_index : state.transcript.length
    const stepType = typeof step.step_type === "string" ? step.step_type : "step"
    const done = step.state === "DONE"
    const usage = readObject(step.usage)
    if (usage) state.usage = usage
    if (typeof step.duration_seconds === "number") state.durationMs = Math.round(step.duration_seconds * 1000)

    if (stepType === "agent_response") {
      const delta = typeof step.text_delta === "string" ? step.text_delta : ""
      const text = (state.steps.get(index) ?? "") + delta
      state.steps.set(index, text)
      state.agentMessages = [...state.steps.values()].filter((message) => message.trim())
      if (text.trim()) state.preview = text
      upsertTranscript(state, {
        id: `message:${index}`,
        kind: "message",
        title: "Assistant",
        text: state.onTranscript ? text : clip(text, MAX_TRANSCRIPT_TEXT),
        status: done ? "completed" : "running",
      })
      return true
    }

    if (stepType === "tool") {
      const info = readObject(step.tool_info)
      const name = typeof step.tool_name === "string" ? step.tool_name : (string(info?.name) ?? "tool")
      const failure = readObject(info?.error)
      const output = string(info?.output)
      upsertTranscript(state, {
        id: `tool:${index}`,
        kind: done ? (failure ? "error" : "tool_result") : "tool_use",
        title: name,
        text: state.onTranscript
          ? done
            ? output || stringify(info?.parameters)
            : stringify(info?.parameters)
          : clip(done ? output || stringify(info?.parameters) : stringify(info?.parameters), MAX_TRANSCRIPT_TEXT),
        status: done ? (failure ? "error" : "completed") : "running",
      })
      return true
    }

    upsertTranscript(state, {
      id: `step:${index}:${stepType}`,
      kind: stepType === "user_input" ? "user" : "status",
      title: stepType === "user_input" ? "User" : stepType.replace(/_/g, " "),
      status: done ? "completed" : "running",
    })
    return true
  }

  if (type === "result") {
    const result = readObject(e.result)
    const status = typeof result?.status === "string" ? result.status : ""
    const response = typeof result?.response === "string" ? result.response.trim() : ""
    const isError = status !== "SUCCESS"
    const resultConversation = typeof result?.conversation_id === "string" ? result.conversation_id : undefined
    if (resultConversation && state.sessionId !== resultConversation) state.sessionId = resultConversation
    state.completed = !isError
    state.usage = readObject(result?.usage) ?? state.usage
    if (typeof result?.duration_seconds === "number") state.durationMs = Math.round(result.duration_seconds * 1000)
    if (response && !state.agentMessages.includes(response)) state.agentMessages.push(response)
    if (response) state.preview = response
    state.error = isError ? response || status || "Antigravity turn failed" : undefined
    upsertTranscript(state, {
      id: `result:${state.sessionId ?? state.transcript.length}`,
      kind: isError ? "error" : "status",
      title: isError ? `Turn failed (${status || "unknown"})` : "Turn completed",
      text:
        state.error || (response ? (state.onTranscript ? response : clip(response, MAX_TRANSCRIPT_TEXT)) : undefined),
      status: isError ? "error" : "completed",
    })
    return true
  }

  if (type === "error") {
    const message = typeof e.message === "string" ? e.message : stringify(e.error) || "Antigravity turn failed"
    state.error = message
    upsertTranscript(state, {
      id: `error:${state.transcript.length}`,
      kind: "error",
      title: "Error",
      text: clip(message, MAX_TRANSCRIPT_TEXT),
    })
    return true
  }

  return false
}

/** Parse full `agy -p --output-format stream-json` JSONL stdout. */
export function parseAntigravityJsonl(stdout: string): AntigravityJsonlParseResult {
  const state = createAntigravityLiveState()
  for (const raw of stdout.split(/\r?\n/)) {
    applyAntigravityJsonlLine(state, raw)
  }
  const finalResponse = state.agentMessages.at(-1)?.trim() ?? ""
  return {
    finalResponse,
    completed: state.completed,
    sessionId: state.sessionId,
    usage: state.usage,
    durationMs: state.durationMs,
    error: state.error,
    agentMessages: state.agentMessages,
    transcript: state.transcript,
    preview: state.preview ?? finalResponse,
  }
}

export function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)))
}

export const AntigravityConsultTool = Tool.define(
  "antigravity_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const configs = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: AntigravityConsultParams, ctx: Tool.Context) => {
        let intervention: ReturnType<typeof registerAdvisorIntervention> | undefined
        return Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)

          yield* ctx.ask({
            permission: "antigravity_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              model: params.model,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })

          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const runtime = resolveExternalCli("antigravity", (yield* configs.get()).external_agents?.antigravity)
          const bin = runtime.binary
          log.info("runtime resolved advisor=antigravity binary=" + bin + " home=" + runtime.home)

          const prompt = params.prompt.trim()
          if (!prompt) {
            throw new Error("prompt must be a non-empty string")
          }

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const args = buildAntigravityExecArgs({
            prompt,
            workingDirectory,
            model: params.model,
          })

          const live = createAntigravityLiveState()
          attachExternalTranscript(ctx, live)
          let lastMetaAt = 0

          const publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              yield* ctx.metadata({
                title: live.preview
                  ? `Antigravity: ${clip(live.preview, 80).replace(/\s+/g, " ")}`
                  : "Running Antigravity",
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
                  usage: live.usage,
                  duration_ms: live.durationMs,
                  intervention: intervention?.snapshot(),
                },
              })
            })

          intervention = ctx.callID
            ? registerAdvisorIntervention({
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                advisor: "antigravity",
                onChange: () => void Effect.runPromise(publishMetadata(true)),
              })
            : undefined

          yield* publishMetadata(true)

          log.info("starting antigravity consult", {
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
                live.completed = false
                live.runSeq = (live.runSeq ?? 0) + 1
                const handle = yield* spawner.spawn(
                  ChildProcess.make(bin, runArgs, {
                    cwd: workingDirectory,
                    extendEnv: true,
                    env: runtime.env,
                    stdin: "ignore",
                  }),
                )

                let stdout = ""
                let stderr = ""
                let lineBuffer = ""

                const stdoutFiber = yield* Effect.forkScoped(
                  Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                    Effect.gen(function* () {
                      stdout += chunk
                      lineBuffer += chunk
                      const parts = lineBuffer.split(/\r?\n/)
                      lineBuffer = parts.pop() ?? ""
                      let dirty = false
                      for (const part of parts) {
                        if (applyAntigravityJsonlLine(live, part)) dirty = true
                      }
                      if (dirty) yield* publishMetadata()
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

                // Process exit can win the race before stdout's final JSONL chunk is consumed.
                yield* Fiber.join(stdoutFiber).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.orElseSucceed(() => void 0),
                )
                yield* Fiber.join(stderrFiber).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.orElseSucceed(() => void 0),
                )

                if (lineBuffer.trim()) applyAntigravityJsonlLine(live, lineBuffer)
                yield* publishMetadata(true)

                log.info("antigravity process finished", {
                  kind: exit.kind,
                  code: exit.code,
                  stdoutLength: stdout.length,
                  stderrLength: stderr.length,
                  stderrPreview: stripAnsi(stderr).trim().slice(0, 500),
                  sessionId: live.sessionId,
                  transcriptItems: live.transcript.length,
                })

                return { exit, stdout, stderr }
              }),
            ).pipe(Effect.orDie)

          let result = yield* runProcess(args)

          if (result.exit.kind === "abort") {
            upsertTranscript(live, {
              id: `aborted:${Date.now()}`,
              kind: "status",
              title: "Stopped",
              text: "Antigravity consultation was aborted",
            })
            yield* publishMetadata(true)
            throw new Error("Antigravity consultation was aborted")
          }
          if (result.exit.kind === "timeout") {
            throw new Error(`Antigravity consultation timed out after ${timeoutMs}ms`)
          }

          const parsed = parseAntigravityJsonl(result.stdout)
          const exitCode = result.exit.code
          let sessionId = live.sessionId ?? parsed.sessionId
          let transcript = live.transcript.length ? live.transcript : parsed.transcript
          const failure = externalTurnFailure({
            advisor: "Antigravity",
            exitCode,
            completed: parsed.completed,
            error: parsed.error,
            answer: parsed.finalResponse,
            stderr: result.stderr,
          })
          log.info("turn validated advisor=antigravity success=" + !failure + " exit=" + exitCode)
          if (failure) throw new Error(failure)
          let body = parsed.finalResponse

          const started = intervention?.isActive() ?? false
          const activeIntervention = intervention
          while (started && activeIntervention?.isActive()) {
            const command = yield* Effect.promise(() => activeIntervention.wait(ctx.abort))
            if (command.type === "abort") throw new Error("Antigravity consultation was aborted")
            if (command.type !== "message") break
            if (!sessionId) throw new Error("Antigravity did not return a session id for intervention")
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
                buildAntigravityResumeArgs({
                  sessionId,
                  prompt: command.message,
                  model: params.model,
                }),
              )
            } finally {
              activeIntervention.setBusy(false)
              yield* publishMetadata(true)
            }
            if (result.exit.kind === "abort") throw new Error("Antigravity consultation was aborted")
            if (result.exit.kind === "timeout")
              throw new Error(`Antigravity consultation timed out after ${timeoutMs}ms`)
            const next = parseAntigravityJsonl(result.stdout)
            const nextBody = next.finalResponse
            const nextError = externalTurnFailure({
              advisor: "Antigravity",
              exitCode: result.exit.code,
              completed: next.completed,
              error: next.error,
              answer: nextBody,
              stderr: result.stderr,
            })
            log.info("followup validated advisor=antigravity success=" + !nextError + " exit=" + result.exit.code)
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
            body = nextBody
            sessionId = live.sessionId ?? next.sessionId ?? sessionId
            transcript = live.transcript.length ? live.transcript : next.transcript
            yield* publishMetadata(true)
          }

          intervention?.close()
          const header = [
            "<antigravity_consult>",
            "tools: full",
            `permission_mode: ${PERMISSION_MODE}`,
            `working_directory: ${workingDirectory}`,
            sessionId ? `session_id: ${sessionId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            "</antigravity_consult>",
          ]
            .filter(Boolean)
            .join("\n")
          return {
            title: "Antigravity execution",
            output: `${header}\n\n${body}`,
            metadata: {
              tools: TOOL_ACCESS,
              permission_mode: PERMISSION_MODE,
              working_directory: workingDirectory,
              prompt,
              session_id: sessionId,
              config_home: runtime.home,
              model: params.model,
              usage: live.usage ?? parsed.usage,
              duration_ms: live.durationMs ?? parsed.durationMs,
              exit_code: result.exit.code,
              preview: body,
              transcript,
            },
          }
        }).pipe(Effect.ensuring(Effect.sync(() => intervention?.close())))
      },
    }
  }),
)

function upsertTranscript(state: AntigravityLiveState, item: AntigravityTranscriptItem) {
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

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function stringify(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "")
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`
}
