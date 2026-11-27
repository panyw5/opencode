import path from "path"
import { Effect, Fiber, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./qoder_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Config } from "@/config/config"
import { externalTurnFailure, resolveExternalCli } from "./external-cli"
import { registerAdvisorIntervention } from "./advisor-intervention"
import { attachExternalTranscript, type TranscriptItem } from "@/session/external"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.qoder_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 120
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_TRANSCRIPT_TEXT = 8_000

const PERMISSION_MODE = "bypass_permissions"
const TOOL_ACCESS = "full"

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for local Qoder. Include goal, absolute paths, constraints, and the exact form of answer you need. Qoder cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory Qoder should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Qoder model override (passed to `qoder --model`).",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type QoderConsultParams = Schema.Schema.Type<typeof Parameters>

export type QoderExecBuildInput = {
  prompt: string
  workingDirectory: string
  configHome: string
  model?: string
}

export function buildQoderResumeArgs(input: {
  sessionId: string
  prompt: string
  workingDirectory: string
  configHome: string
  model?: string
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--permission-mode",
    PERMISSION_MODE,
    "--config-dir",
    input.configHome,
    "--cwd",
    input.workingDirectory,
    "--session-id",
    input.sessionId,
  ]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  args.push("--", input.prompt)
  return args
}

export type QoderTranscriptItem = {
  id: string
  kind: "message" | "user" | "tool_use" | "tool_result" | "status" | "error" | "thinking"
  title?: string
  text?: string
  status?: string
}

export type QoderLiveState = {
  completed?: boolean
  onTranscript?: (item: TranscriptItem) => void
  runSeq?: number
  sessionId?: string
  usage?: Record<string, unknown>
  durationMs?: number
  error?: string
  agentMessages: string[]
  transcript: QoderTranscriptItem[]
  preview?: string
}

/** Build argv for a full-access one-shot `qoder -p` execution. */
export function buildQoderExecArgs(input: QoderExecBuildInput): string[] {
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

  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--permission-mode",
    PERMISSION_MODE,
    "--config-dir",
    input.configHome,
    "--cwd",
    input.workingDirectory,
  ]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  // `--` keeps the prompt from being consumed by variadic options.
  args.push("--", framed)
  return args
}

export type QoderJsonlParseResult = {
  completed?: boolean
  finalResponse: string
  sessionId?: string
  usage?: QoderLiveState["usage"]
  durationMs?: number
  error?: string
  agentMessages: string[]
  transcript: QoderTranscriptItem[]
  preview?: string
}

export function createQoderLiveState(): QoderLiveState {
  return { agentMessages: [], transcript: [] }
}

/** Apply one `qoder -p --output-format stream-json` JSONL event into live state. */
export function applyQoderJsonlLine(state: QoderLiveState, rawLine: string): boolean {
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
  const type = typeof e.type === "string" ? e.type : ""

  if (typeof e.session_id === "string" && e.session_id && state.sessionId !== e.session_id) {
    state.sessionId = e.session_id
  }

  if (type === "system") {
    const subtype = typeof e.subtype === "string" ? e.subtype : "system"
    upsertTranscript(state, {
      id: `system:${subtype}:${state.transcript.length}`,
      kind: "status",
      title: subtype === "init" ? "Session started" : "System",
      text: state.sessionId,
    })
    return true
  }

  if (type === "assistant") {
    const message = readObject(e.message)
    const contents = Array.isArray(message?.content) ? message.content : []
    let changed = false
    for (const [contentIndex, content] of contents.entries()) {
      if (!content || typeof content !== "object") continue
      const item = content as Record<string, unknown>
      const itemType = typeof item.type === "string" ? item.type : ""
      const messageID =
        typeof message?.id === "string" ? message.id : typeof e.uuid === "string" ? e.uuid : state.transcript.length
      const id = typeof item.id === "string" && item.id ? item.id : `${itemType}:${messageID}:${contentIndex}`

      if (itemType === "text" && typeof item.text === "string" && item.text.trim()) {
        if (!state.agentMessages.includes(item.text)) state.agentMessages.push(item.text)
        state.preview = item.text
        upsertTranscript(state, {
          id,
          kind: "message",
          title: "Assistant",
          text: state.onTranscript ? item.text : clip(item.text, MAX_TRANSCRIPT_TEXT),
          status: "completed",
        })
        changed = true
      }

      if ((itemType === "tool_use" || itemType === "server_tool_use") && typeof item.name === "string") {
        upsertTranscript(state, {
          id,
          kind: "tool_use",
          title: item.name,
          text: state.onTranscript ? stringify(item.input) : clip(stringify(item.input), MAX_TRANSCRIPT_TEXT),
          status: "running",
        })
        changed = true
      }

      if ((itemType === "thinking" || itemType === "redacted_thinking") && typeof item.thinking === "string") {
        upsertTranscript(state, {
          id,
          kind: "thinking",
          title: "Thinking",
          text: state.onTranscript ? item.thinking : clip(item.thinking, MAX_TRANSCRIPT_TEXT),
        })
        changed = true
      }
    }
    return changed
  }

  if (type === "user") {
    const message = readObject(e.message)
    const contents = Array.isArray(message?.content) ? message.content : []
    let changed = false
    for (const content of contents) {
      if (!content || typeof content !== "object") continue
      const item = content as Record<string, unknown>
      if (item.type !== "tool_result") continue
      const toolUseID =
        typeof item.tool_use_id === "string" ? item.tool_use_id : `tool_result:${state.transcript.length}`
      const isError = item.is_error === true
      const text = typeof item.content === "string" ? item.content : stringify(item.content)
      upsertTranscript(state, {
        id: `result:${toolUseID}`,
        kind: isError ? "error" : "tool_result",
        title: "Tool result",
        text: state.onTranscript ? text : clip(text, MAX_TRANSCRIPT_TEXT),
        status: isError ? "error" : "completed",
      })
      changed = true
    }
    return changed
  }

  if (type === "result") {
    const resultText = typeof e.result === "string" ? e.result.trim() : ""
    const isError = e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success")
    const errors = Array.isArray(e.errors) ? e.errors.filter((error): error is string => typeof error === "string") : []
    state.completed = !isError
    state.usage = readObject(e.usage) ?? state.usage
    state.durationMs = typeof e.duration_ms === "number" ? e.duration_ms : state.durationMs
    if (resultText && !state.agentMessages.includes(resultText)) state.agentMessages.push(resultText)
    if (resultText) state.preview = resultText
    state.error = isError ? errors.join("\n") || resultText || String(e.subtype || "Qoder turn failed") : undefined
    upsertTranscript(state, {
      id: `result:${state.sessionId ?? state.transcript.length}`,
      kind: isError ? "error" : "status",
      title: isError ? "Turn failed" : "Turn completed",
      text:
        state.error ||
        (resultText ? (state.onTranscript ? resultText : clip(resultText, MAX_TRANSCRIPT_TEXT)) : undefined),
      status: isError ? "error" : "completed",
    })
    return true
  }

  if (type === "error") {
    const message = typeof e.message === "string" ? e.message : stringify(e.error) || "Qoder turn failed"
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

/** Parse full `qoder -p --output-format stream-json` JSONL stdout. */
export function parseQoderJsonl(stdout: string): QoderJsonlParseResult {
  const state = createQoderLiveState()
  for (const raw of stdout.split(/\r?\n/)) {
    applyQoderJsonlLine(state, raw)
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

export const QoderConsultTool = Tool.define(
  "qoder_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const configs = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: QoderConsultParams, ctx: Tool.Context) => {
        let intervention: ReturnType<typeof registerAdvisorIntervention> | undefined
        return Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)

          yield* ctx.ask({
            permission: "qoder_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              model: params.model,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })

          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const runtime = resolveExternalCli("qoder", (yield* configs.get()).external_agents?.qoder)
          const bin = runtime.binary
          log.info("runtime resolved advisor=qoder binary=" + bin + " home=" + runtime.home)

          const prompt = params.prompt.trim()
          if (!prompt) {
            throw new Error("prompt must be a non-empty string")
          }

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const args = buildQoderExecArgs({
            prompt,
            workingDirectory,
            configHome: runtime.home,
            model: params.model,
          })

          const live = createQoderLiveState()
          attachExternalTranscript(ctx, live)
          let lastMetaAt = 0

          const publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              yield* ctx.metadata({
                title: live.preview ? `Qoder: ${clip(live.preview, 80).replace(/\s+/g, " ")}` : "Running Qoder",
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
                advisor: "qoder",
                onChange: () => void Effect.runPromise(publishMetadata(true)),
              })
            : undefined

          yield* publishMetadata(true)

          log.info("starting qoder consult", {
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
                        if (applyQoderJsonlLine(live, part)) dirty = true
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

                if (lineBuffer.trim()) applyQoderJsonlLine(live, lineBuffer)
                yield* publishMetadata(true)

                log.info("qoder process finished", {
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
              text: "Qoder consultation was aborted",
            })
            yield* publishMetadata(true)
            throw new Error("Qoder consultation was aborted")
          }
          if (result.exit.kind === "timeout") {
            throw new Error(`Qoder consultation timed out after ${timeoutMs}ms`)
          }

          const parsed = parseQoderJsonl(result.stdout)
          const exitCode = result.exit.code
          let sessionId = live.sessionId ?? parsed.sessionId
          let transcript = live.transcript.length ? live.transcript : parsed.transcript
          const failure = externalTurnFailure({
            advisor: "Qoder",
            exitCode,
            completed: parsed.completed,
            error: parsed.error,
            answer: parsed.finalResponse,
            stderr: result.stderr,
          })
          log.info("turn validated advisor=qoder success=" + !failure + " exit=" + exitCode)
          if (failure) throw new Error(failure)
          let body = parsed.finalResponse

          const started = intervention?.isActive() ?? false
          const activeIntervention = intervention
          while (started && activeIntervention?.isActive()) {
            const command = yield* Effect.promise(() => activeIntervention.wait(ctx.abort))
            if (command.type === "abort") throw new Error("Qoder consultation was aborted")
            if (command.type !== "message") break
            if (!sessionId) throw new Error("Qoder did not return a session id for intervention")
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
                buildQoderResumeArgs({
                  sessionId,
                  prompt: command.message,
                  workingDirectory,
                  configHome: runtime.home,
                  model: params.model,
                }),
              )
            } finally {
              activeIntervention.setBusy(false)
              yield* publishMetadata(true)
            }
            if (result.exit.kind === "abort") throw new Error("Qoder consultation was aborted")
            if (result.exit.kind === "timeout") throw new Error(`Qoder consultation timed out after ${timeoutMs}ms`)
            const next = parseQoderJsonl(result.stdout)
            const nextBody = next.finalResponse
            const nextError = externalTurnFailure({
              advisor: "Qoder",
              exitCode: result.exit.code,
              completed: next.completed,
              error: next.error,
              answer: nextBody,
              stderr: result.stderr,
            })
            log.info("followup validated advisor=qoder success=" + !nextError + " exit=" + result.exit.code)
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
            "<qoder_consult>",
            "tools: full",
            `permission_mode: ${PERMISSION_MODE}`,
            `working_directory: ${workingDirectory}`,
            sessionId ? `session_id: ${sessionId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            "</qoder_consult>",
          ]
            .filter(Boolean)
            .join("\n")
          return {
            title: "Qoder execution",
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

function upsertTranscript(state: QoderLiveState, item: QoderTranscriptItem) {
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
