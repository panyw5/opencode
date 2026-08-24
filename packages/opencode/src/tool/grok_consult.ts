import path from "path"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./grok_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { which } from "@/util/which"
import { registerAdvisorIntervention } from "./advisor-intervention"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.grok_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 120
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_TRANSCRIPT_TEXT = 8_000

const PERMISSION_MODE = "bypassPermissions"
const TOOL_ACCESS = "full"

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for local Grok Build. Include goal, absolute paths, constraints, and the exact form of answer you need. Grok cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory Grok should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Grok model override (passed to `grok --model`)." }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type GrokConsultParams = Schema.Schema.Type<typeof Parameters>

export type GrokExecBuildInput = {
  prompt: string
  workingDirectory: string
  model?: string
}

export type GrokTranscriptItem = {
  id: string
  kind: "message" | "user" | "tool_use" | "status" | "error" | "thinking"
  title?: string
  text?: string
  status?: string
}

export type GrokLiveState = {
  sessionId?: string
  error?: string
  assistantText: string
  thinkingText: string
  thinkingIndex: number
  thinkingOpen: boolean
  transcript: GrokTranscriptItem[]
  preview?: string
}

export type GrokJsonlParseResult = {
  finalResponse: string
  sessionId?: string
  error?: string
  transcript: GrokTranscriptItem[]
  preview?: string
}

/** Build argv for a non-interactive Grok Build execution with its full tool set. */
export function buildGrokExecArgs(input: GrokExecBuildInput): string[] {
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
    "--single",
    framed,
    "--cwd",
    input.workingDirectory,
    "--output-format",
    "streaming-json",
    "--permission-mode",
    PERMISSION_MODE,
  ]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  return args
}

/** Resume an existing Grok Build execution with its full tool set. */
export function buildGrokResumeArgs(input: GrokExecBuildInput & { sessionId: string }): string[] {
  const args = [
    "--single",
    input.prompt,
    "--resume",
    input.sessionId,
    "--cwd",
    input.workingDirectory,
    "--output-format",
    "streaming-json",
    "--permission-mode",
    PERMISSION_MODE,
  ]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  return args
}

export function createGrokLiveState(): GrokLiveState {
  return { assistantText: "", thinkingText: "", thinkingIndex: 0, thinkingOpen: false, transcript: [] }
}

/** Apply one `grok --output-format streaming-json` event into live state. */
export function applyGrokJsonlLine(state: GrokLiveState, rawLine: string): boolean {
  const line = rawLine.trim()
  if (!line) return false
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return false
  }
  if (!event || typeof event !== "object") return false
  const item = event as Record<string, unknown>
  const type = typeof item.type === "string" ? item.type : ""
  const sessionId = string(item.sessionId) ?? string(item.session_id)
  if (sessionId) state.sessionId = sessionId

  if (type === "text") {
    const chunk = string(item.data) ?? string(item.text) ?? ""
    if (!chunk) return false
    closeThinking(state)
    state.assistantText += chunk
    state.preview = state.assistantText
    upsertTranscript(state, {
      id: "assistant:stream",
      kind: "message",
      title: "Assistant",
      text: clip(state.assistantText, MAX_TRANSCRIPT_TEXT),
      status: "running",
    })
    // Grok can interleave more thinking/tool events after starting its reply.
    // Keep the mutable reply at the end so the transcript remains readable.
    moveTranscriptToEnd(state, "assistant:stream")
    return true
  }

  if (type === "thinking" || type === "thought") {
    const text = string(item.data) ?? string(item.text) ?? ""
    if (!text) return false
    if (!state.thinkingOpen) {
      state.thinkingOpen = true
      state.thinkingText = ""
      state.thinkingIndex++
    }
    state.thinkingText += text
    upsertTranscript(state, {
      id: `thinking:${state.thinkingIndex}`,
      kind: "thinking",
      title: "Thinking",
      text: clip(state.thinkingText, MAX_TRANSCRIPT_TEXT),
      status: "running",
    })
    moveTranscriptToEnd(state, "assistant:stream")
    return true
  }

  if (type === "tool_call" || type === "tool") {
    closeThinking(state)
    const id = string(item.id) ?? `tool:${state.transcript.length}`
    const title = string(item.title) ?? string(item.name) ?? "Tool"
    upsertTranscript(state, {
      id,
      kind: "tool_use",
      title,
      text: clip(stringify(item.input ?? item.data), MAX_TRANSCRIPT_TEXT),
      status: string(item.status) ?? "running",
    })
    moveTranscriptToEnd(state, "assistant:stream")
    return true
  }

  if (type === "error") {
    closeThinking(state)
    const message = string(item.message) ?? string(item.error) ?? "Grok Build turn failed"
    state.error = message
    upsertTranscript(state, { id: `error:${state.transcript.length}`, kind: "error", title: "Error", text: message })
    return true
  }

  if (type === "end" || type === "result" || type === "done") {
    closeThinking(state)
    const result = string(item.text) ?? string(item.data)
    if (result && !state.assistantText) state.assistantText = result
    if (state.assistantText) state.preview = state.assistantText
    if (item.error === true) state.error = result ?? "Grok Build turn failed"
    closeAssistant(state)
    upsertTranscript(state, {
      id: `result:${state.sessionId ?? state.transcript.length}`,
      kind: state.error ? "error" : "status",
      title: state.error ? "Turn failed" : "Turn completed",
      status: state.error ? "error" : "completed",
    })
    return true
  }

  return false
}

export function parseGrokJsonl(stdout: string): GrokJsonlParseResult {
  const state = createGrokLiveState()
  for (const line of stdout.split(/\r?\n/)) applyGrokJsonlLine(state, line)
  return {
    finalResponse: state.assistantText.trim(),
    sessionId: state.sessionId,
    error: state.error,
    transcript: state.transcript,
    preview: state.preview ?? state.assistantText,
  }
}

export function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)))
}

export const GrokConsultTool = Tool.define(
  "grok_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: GrokConsultParams, ctx: Tool.Context) => {
        let intervention: ReturnType<typeof registerAdvisorIntervention> | undefined
        return Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)
          yield* ctx.ask({
            permission: "grok_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              model: params.model,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })
          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const bin = which("grok")
          if (!bin) {
            throw new Error("Grok Build CLI not found on PATH. Install Grok Build and ensure `grok` is available on PATH, then authenticate and retry.")
          }
          const prompt = params.prompt.trim()
          if (!prompt) throw new Error("prompt must be a non-empty string")

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const live = createGrokLiveState()
          let lastMetaAt = 0
          let publishMetadata: (force?: boolean) => Effect.Effect<void>
          intervention = ctx.callID
            ? registerAdvisorIntervention({
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                advisor: "grok",
                onChange: () => void Effect.runPromise(publishMetadata(true)),
              })
            : undefined

          publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              yield* ctx.metadata({
                title: live.preview ? `Grok: ${clip(live.preview, 80).replace(/\s+/g, " ")}` : "Running Grok Build",
                metadata: {
                  bin,
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

          yield* publishMetadata(true)

          const runProcess = (args: string[]) =>
            Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* spawner.spawn(
                  ChildProcess.make(bin, args, { cwd: workingDirectory, extendEnv: true, stdin: "ignore" }),
                )
                let stdout = ""
                let stderr = ""
                let lineBuffer = ""
                yield* Effect.forkScoped(
                  Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                    Effect.gen(function* () {
                      stdout += chunk
                      lineBuffer += chunk
                      const lines = lineBuffer.split(/\r?\n/)
                      lineBuffer = lines.pop() ?? ""
                      let dirty = false
                      for (const line of lines) if (applyGrokJsonlLine(live, line)) dirty = true
                      if (dirty) yield* publishMetadata()
                    }),
                  ),
                )
                yield* Effect.forkScoped(Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) => Effect.sync(() => (stderr += chunk))))
                const abort = Effect.callback<void>((resume) => {
                  if (ctx.abort.aborted) return resume(Effect.void)
                  const onAbort = () => resume(Effect.void)
                  ctx.abort.addEventListener("abort", onAbort, { once: true })
                  return Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort))
                })
                const exit = yield* Effect.raceAll([
                  handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code: Number(code) })), Effect.orDie),
                  abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null as number | null }))),
                  Effect.sleep(`${timeoutMs} millis`).pipe(Effect.map(() => ({ kind: "timeout" as const, code: null as number | null }))),
                ])
                if (exit.kind !== "exit") yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
                if (lineBuffer.trim()) applyGrokJsonlLine(live, lineBuffer)
                return { exit, stdout, stderr }
              }),
            ).pipe(Effect.orDie)

          log.info("starting grok consult", { bin, cwd: workingDirectory, model: params.model, timeoutMs })
          let result = yield* runProcess(buildGrokExecArgs({ prompt, workingDirectory, model: params.model }))
          if (result.exit.kind === "abort") throw new Error("Grok Build consultation was aborted")
          if (result.exit.kind === "timeout") throw new Error(`Grok Build consultation timed out after ${timeoutMs}ms`)

          const parsed = parseGrokJsonl(result.stdout)
          let sessionId = live.sessionId ?? parsed.sessionId
          let body = live.assistantText.trim() || parsed.finalResponse || stripAnsi(result.stdout).trim() || stripAnsi(result.stderr).trim()
          if ((live.error ?? parsed.error) && !body) throw new Error(`Grok Build failed: ${live.error ?? parsed.error}`)
          if (result.exit.code !== 0 && !body) {
            const detail = (live.error ?? parsed.error ?? result.stderr ?? result.stdout).trim().slice(0, 4000)
            throw new Error(`Grok Build exited with code ${result.exit.code}${detail ? `: ${detail}` : ""}. Ensure \`grok\` is authenticated and reachable.`)
          }
          if (!body) throw new Error("Grok Build returned an empty response")

          const started = intervention?.isActive() ?? false
          log.info("grok consult turn completed", {
            sessionID: ctx.sessionID,
            callID: ctx.callID,
            exitCode: result.exit.code,
            interventionActive: started,
          })
          const activeIntervention = intervention
          while (started && activeIntervention?.isActive()) {
            const command = yield* Effect.promise(() => activeIntervention.wait(ctx.abort))
            if (command.type === "abort") throw new Error("Grok Build consultation was aborted")
            if (command.type !== "message") break
            if (!sessionId) throw new Error("Grok Build did not return a session id for intervention")
            upsertTranscript(live, { id: `intervention-user:${Date.now()}`, kind: "user", title: "User", text: command.message, status: "completed" })
            activeIntervention.setBusy(true)
            try {
              result = yield* runProcess(buildGrokResumeArgs({ sessionId, prompt: command.message, workingDirectory, model: params.model }))
            } finally {
              activeIntervention.setBusy(false)
              yield* publishMetadata(true)
            }
            if (result.exit.kind === "abort") throw new Error("Grok Build consultation was aborted")
            if (result.exit.kind === "timeout") throw new Error(`Grok Build consultation timed out after ${timeoutMs}ms`)
            const next = parseGrokJsonl(result.stdout)
            const nextBody = live.assistantText.trim() || next.finalResponse || stripAnsi(result.stdout).trim() || stripAnsi(result.stderr).trim()
            if (!nextBody) {
              upsertTranscript(live, {
                id: `intervention-error:${Date.now()}`,
                kind: "error",
                title: "Error",
                text: "Grok Build returned an empty response",
                status: "error",
              })
              yield* publishMetadata(true)
              continue
            }
            body = nextBody
            sessionId = live.sessionId ?? next.sessionId ?? sessionId
            yield* publishMetadata(true)
          }

          intervention?.close()
          const header = [
            "<grok_consult>",
            "tools: full",
            `permission_mode: ${PERMISSION_MODE}`,
            `working_directory: ${workingDirectory}`,
            sessionId ? `session_id: ${sessionId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            "</grok_consult>",
          ]
            .filter(Boolean)
            .join("\n")
          return {
            title: "Grok Build execution",
            output: `${header}\n\n${body}`,
            metadata: {
              tools: TOOL_ACCESS,
              permission_mode: PERMISSION_MODE,
              working_directory: workingDirectory,
              prompt,
              session_id: sessionId,
              model: params.model,
              exit_code: result.exit.code,
              preview: body,
              transcript: live.transcript.length ? live.transcript : parsed.transcript,
            },
          }
        }).pipe(Effect.ensuring(Effect.sync(() => intervention?.close())))
      },
    }
  }),
)

function upsertTranscript(state: GrokLiveState, item: GrokTranscriptItem) {
  const index = state.transcript.findIndex((entry) => entry.id === item.id)
  if (index >= 0) state.transcript[index] = { ...state.transcript[index], ...item }
  else {
    state.transcript.push(item)
    if (state.transcript.length > MAX_TRANSCRIPT_ITEMS) state.transcript.splice(0, state.transcript.length - MAX_TRANSCRIPT_ITEMS)
  }
}

function moveTranscriptToEnd(state: GrokLiveState, id: string) {
  const index = state.transcript.findIndex((entry) => entry.id === id)
  if (index < 0 || index === state.transcript.length - 1) return
  const [item] = state.transcript.splice(index, 1)
  if (item) state.transcript.push(item)
}

function closeAssistant(state: GrokLiveState) {
  const item = state.transcript.find((entry) => entry.id === "assistant:stream")
  if (item?.status === "running") item.status = "completed"
}

function closeThinking(state: GrokLiveState) {
  if (!state.thinkingOpen) return
  state.thinkingOpen = false
  const id = `thinking:${state.thinkingIndex}`
  const item = state.transcript.find((entry) => entry.id === id)
  if (item) item.status = "completed"
}

function resolveWorkingDirectory(input: string | undefined, projectDirectory: string): string {
  if (!input?.trim()) return projectDirectory
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(projectDirectory, input)
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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "")
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`
}
