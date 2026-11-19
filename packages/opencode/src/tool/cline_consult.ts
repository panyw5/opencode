import path from "path"
import { Effect, Fiber, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./cline_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Config } from "@/config/config"
import { externalTurnFailure, resolveExternalCli } from "./external-cli"
import { registerAdvisorIntervention } from "./advisor-intervention"
import { attachExternalTranscript, type TranscriptItem } from "@/session/external"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.cline_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 120
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_TRANSCRIPT_TEXT = 8_000

const PERMISSION_MODE = "auto-approve"
const TOOL_ACCESS = "full"
const DONE_REASONS = new Set(["completed", "end_turn", "stop", "success"])

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for local Cline. Include goal, absolute paths, constraints, and the exact form of answer you need. Cline cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory Cline should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Cline model override (passed to `cline --model`).",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type ClineConsultParams = Schema.Schema.Type<typeof Parameters>

export type ClineExecBuildInput = {
  prompt: string
  workingDirectory: string
  configHome: string
  model?: string
}

export type ClineTranscriptItem = {
  id: string
  kind: "message" | "user" | "tool_use" | "status" | "error" | "thinking"
  title?: string
  text?: string
  status?: string
}

export type ClineLiveState = {
  completed: boolean
  stopReason?: string
  onTranscript?: (item: TranscriptItem) => void
  runSeq?: number
  sessionId?: string
  error?: string
  assistantText: string
  assistantSegmentText: string
  assistantIndex: number
  assistantOpen: boolean
  thinkingText: string
  thinkingIndex: number
  thinkingOpen: boolean
  transcript: ClineTranscriptItem[]
  preview?: string
}

export type ClineJsonlParseResult = {
  completed: boolean
  stopReason?: string
  finalResponse: string
  sessionId?: string
  error?: string
  transcript: ClineTranscriptItem[]
  preview?: string
}

/** Build argv for a non-interactive `cline --json` execution with auto-approved tools. */
export function buildClineExecArgs(input: ClineExecBuildInput): string[] {
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

  const args = ["--json", "--auto-approve", "true", "--config", input.configHome, "--cwd", input.workingDirectory]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  args.push("--", framed)
  return args
}

/** Resume an existing Cline session with the same one-shot JSON mode. */
export function buildClineResumeArgs(input: ClineExecBuildInput & { sessionId: string }): string[] {
  const args = [
    "--json",
    "--auto-approve",
    "true",
    "--config",
    input.configHome,
    "--cwd",
    input.workingDirectory,
    "--id",
    input.sessionId,
  ]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  args.push("--", input.prompt)
  return args
}

export function createClineLiveState(): ClineLiveState {
  return {
    completed: false,
    assistantText: "",
    assistantSegmentText: "",
    assistantIndex: 0,
    assistantOpen: false,
    thinkingText: "",
    thinkingIndex: 0,
    thinkingOpen: false,
    transcript: [],
  }
}

export function beginClineTurn(state: ClineLiveState) {
  state.runSeq = (state.runSeq ?? 0) + 1
  state.assistantText = ""
  state.assistantSegmentText = ""
  state.assistantOpen = false
  state.thinkingText = ""
  state.thinkingOpen = false
  state.error = undefined
  state.preview = undefined
  state.completed = false
  state.stopReason = undefined
}

/** Apply one `cline --json` NDJSON event into live state. */
export function applyClineJsonlLine(state: ClineLiveState, rawLine: string): boolean {
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
  const outer = string(item.type) ?? ""
  const inner = (item.event ?? {}) as Record<string, unknown>
  const type = outer === "agent_event" ? (string(inner.type) ?? "") : outer
  const payload = outer === "agent_event" ? inner : item

  const sessionId =
    string(payload.sessionId) ??
    string(payload.session_id) ??
    string(payload.taskId) ??
    string(payload.task_id) ??
    string(inner.sessionId) ??
    string(inner.taskId)
  if (sessionId) state.sessionId = sessionId

  if (type === "content_start" || type === "content_update" || type === "say") {
    const chunk = string(payload.text) ?? string(payload.message) ?? string(payload.data) ?? ""
    if (!chunk) return false
    closeThinking(state)
    if (!state.assistantOpen) {
      state.assistantOpen = true
      state.assistantIndex++
      state.assistantSegmentText = ""
    }
    // Cline events may carry either deltas or cumulative text for the open segment.
    if (chunk.startsWith(state.assistantSegmentText)) {
      state.assistantText += chunk.slice(state.assistantSegmentText.length)
      state.assistantSegmentText = chunk
    } else {
      state.assistantText += chunk
      state.assistantSegmentText += chunk
    }
    state.preview = state.assistantText
    upsertTranscript(state, {
      id: `assistant:${state.assistantIndex}`,
      kind: "message",
      title: "Assistant",
      text: state.onTranscript ? state.assistantSegmentText : clip(state.assistantSegmentText, MAX_TRANSCRIPT_TEXT),
      status: "running",
    })
    return true
  }

  if (type === "content_end") {
    closeAssistant(state)
    return true
  }

  if (type === "thinking" || type === "thought" || type === "reasoning") {
    const text = string(payload.text) ?? string(payload.data) ?? ""
    if (!text) return false
    if (!state.thinkingOpen) {
      state.thinkingOpen = true
      state.thinkingText = ""
      state.thinkingIndex++
    }
    state.thinkingText = text.startsWith(state.thinkingText) ? text : state.thinkingText + text
    upsertTranscript(state, {
      id: `thinking:${state.thinkingIndex}`,
      kind: "thinking",
      title: "Thinking",
      text: state.onTranscript ? state.thinkingText : clip(state.thinkingText, MAX_TRANSCRIPT_TEXT),
      status: "running",
    })
    closeAssistant(state)
    return true
  }

  if (type === "tool_call" || type === "tool_use" || type === "tool") {
    closeThinking(state)
    closeAssistant(state)
    const id = string(payload.toolCallId) ?? string(payload.tool_use_id) ?? string(payload.id) ?? `tool:${state.transcript.length}`
    const title = string(payload.title) ?? string(payload.toolName) ?? string(payload.name) ?? "Tool"
    upsertTranscript(state, {
      id,
      kind: "tool_use",
      title,
      text: state.onTranscript
        ? stringify(payload.rawInput ?? payload.input ?? payload.data)
        : clip(stringify(payload.rawInput ?? payload.input ?? payload.data), MAX_TRANSCRIPT_TEXT),
      status: string(payload.status) ?? "running",
    })
    return true
  }

  if (type === "tool_call_update" || type === "tool_result") {
    const id = string(payload.toolCallId) ?? string(payload.tool_use_id) ?? string(payload.id)
    if (!id) return false
    const index = state.transcript.findIndex((entry) => entry.id === id)
    const status = string(payload.status)
    const text = string(payload.text) ?? stringify(payload.content ?? payload.output)
    if (index < 0) {
      upsertTranscript(state, {
        id,
        kind: "tool_use",
        title: "Tool",
        text: state.onTranscript ? text : clip(text, MAX_TRANSCRIPT_TEXT),
        status: status ?? "completed",
      })
      return true
    }
    if (status) state.transcript[index]!.status = status === "in_progress" ? "running" : status
    if (text) {
      const entry = state.transcript[index]!
      entry.text = clip(entry.text ? `${entry.text}\n${text}` : text, MAX_TRANSCRIPT_TEXT)
    }
    state.onTranscript?.({ ...state.transcript[index]!, id: `${state.runSeq ?? 0}:${state.transcript[index]!.id}` })
    return true
  }

  if (type === "notice") {
    const text = string(payload.text) ?? string(payload.message)
    if (!text) return false
    upsertTranscript(state, {
      id: `notice:${state.transcript.length}`,
      kind: "status",
      title: "Notice",
      text: clip(text, MAX_TRANSCRIPT_TEXT),
    })
    return true
  }

  if (type === "usage") {
    upsertTranscript(state, {
      id: `usage:${state.transcript.length}`,
      kind: "status",
      title: "Usage",
      text: clip(stringify(payload), 500),
    })
    return true
  }

  if (type === "error") {
    closeThinking(state)
    const message = string(payload.message) ?? string(payload.error) ?? "Cline turn failed"
    state.error = message
    state.completed = false
    closeAssistant(state, "error")
    upsertTranscript(state, { id: `error:${state.transcript.length}`, kind: "error", title: "Error", text: message })
    return true
  }

  if (type === "run_aborted") {
    state.error = string(payload.message) ?? string(payload.reason) ?? "Cline run was aborted"
    state.completed = false
    closeThinking(state)
    closeAssistant(state, "error")
    upsertTranscript(state, {
      id: `aborted:${state.transcript.length}`,
      kind: "error",
      title: "Run aborted",
      text: state.error,
      status: "error",
    })
    return true
  }

  if (type === "run_result" || type === "result" || type === "done") {
    closeThinking(state)
    const reason = (
      string(payload.finishReason) ??
      string(payload.finish_reason) ??
      string(payload.reason) ??
      string(payload.stopReason) ??
      string(payload.stop_reason)
    )
      ?.replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/-/g, "_")
      .toLowerCase()
    state.stopReason = reason
    const result = string(payload.text) ?? string(payload.result) ?? string(payload.data)
    if (result && !state.assistantText) state.assistantText = result
    if (state.assistantText) state.preview = state.assistantText
    const failed = payload.is_error === true || payload.error === true || (reason ? !DONE_REASONS.has(reason) : false)
    if (failed) state.error ??= result ?? "Cline turn failed"
    if (reason && !failed) state.completed = true
    if (type === "done" && !reason) state.completed = !state.error
    closeAssistant(state, state.completed ? "completed" : "error")
    upsertTranscript(state, {
      id: `result:${state.sessionId ?? state.transcript.length}`,
      kind: state.error ? "error" : "status",
      title: state.error ? "Turn failed" : "Turn completed",
      text: state.error,
      status: state.error ? "error" : "completed",
    })
    return true
  }

  return false
}

export function parseClineJsonl(stdout: string): ClineJsonlParseResult {
  const state = createClineLiveState()
  for (const line of stdout.split(/\r?\n/)) applyClineJsonlLine(state, line)
  if (!state.completed) {
    closeThinking(state)
    closeAssistant(state, "error")
  }
  return {
    completed: state.completed,
    stopReason: state.stopReason,
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

export const ClineConsultTool = Tool.define(
  "cline_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const configs = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: ClineConsultParams, ctx: Tool.Context) => {
        let intervention: ReturnType<typeof registerAdvisorIntervention> | undefined
        return Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)
          yield* ctx.ask({
            permission: "cline_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              model: params.model,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })
          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const runtime = resolveExternalCli("cline", (yield* configs.get()).external_agents?.cline)
          const bin = runtime.binary
          const env = { ...runtime.env }
          log.info("runtime resolved advisor=cline binary=" + bin + " home=" + runtime.home)
          const prompt = params.prompt.trim()
          if (!prompt) throw new Error("prompt must be a non-empty string")

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const live = createClineLiveState()
          attachExternalTranscript(ctx, live)
          let lastMetaAt = 0
          let publishMetadata: (force?: boolean) => Effect.Effect<void>
          intervention = ctx.callID
            ? registerAdvisorIntervention({
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                advisor: "cline",
                onChange: () => void Effect.runPromise(publishMetadata(true)),
              })
            : undefined

          publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              yield* ctx.metadata({
                title: live.preview ? `Cline: ${clip(live.preview, 80).replace(/\s+/g, " ")}` : "Running Cline",
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
                  stop_reason: live.stopReason,
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
                beginClineTurn(live)
                log.info("process starting advisor=cline run=" + live.runSeq + " resume=" + args.includes("--id"))
                const handle = yield* spawner.spawn(
                  ChildProcess.make(bin, args, { cwd: workingDirectory, extendEnv: true, env, stdin: "ignore" }),
                )
                let stdout = ""
                let stderr = ""
                let lineBuffer = ""
                const stdoutFiber = yield* Effect.forkScoped(
                  Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                    Effect.gen(function* () {
                      stdout += chunk
                      lineBuffer += chunk
                      const lines = lineBuffer.split(/\r?\n/)
                      lineBuffer = lines.pop() ?? ""
                      let dirty = false
                      for (const line of lines) if (applyClineJsonlLine(live, line)) dirty = true
                      if (dirty) yield* publishMetadata()
                    }),
                  ),
                )
                const stderrFiber = yield* Effect.forkScoped(
                  Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) => Effect.sync(() => (stderr += chunk))),
                )
                const abort = Effect.callback<void>((resume) => {
                  if (ctx.abort.aborted) return resume(Effect.void)
                  const onAbort = () => resume(Effect.void)
                  ctx.abort.addEventListener("abort", onAbort, { once: true })
                  return Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort))
                })
                const exit = yield* Effect.raceAll([
                  handle.exitCode.pipe(
                    Effect.map((code) => ({ kind: "exit" as const, code: Number(code) })),
                    Effect.orDie,
                  ),
                  abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null as number | null }))),
                  Effect.sleep(`${timeoutMs} millis`).pipe(
                    Effect.map(() => ({ kind: "timeout" as const, code: null as number | null })),
                  ),
                ])
                if (exit.kind !== "exit") yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
                yield* Fiber.join(stdoutFiber).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.orElseSucceed(() => void 0),
                )
                yield* Fiber.join(stderrFiber).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.orElseSucceed(() => void 0),
                )
                if (lineBuffer.trim()) applyClineJsonlLine(live, lineBuffer)
                if (!live.completed) {
                  closeThinking(live)
                  closeAssistant(live, "error")
                }
                yield* publishMetadata(true)
                log.info(
                  "process drained advisor=cline exit=" +
                    exit.code +
                    " completed=" +
                    live.completed +
                    " reason=" +
                    (live.stopReason ?? "missing"),
                )
                return { exit, stdout, stderr }
              }),
            ).pipe(Effect.orDie)

          log.info("starting cline consult", {
            bin,
            cwd: workingDirectory,
            model: params.model,
            timeoutMs,
          })
          let result = yield* runProcess(
            buildClineExecArgs({ prompt, workingDirectory, configHome: runtime.home, model: params.model }),
          )
          if (result.exit.kind === "abort") throw new Error("Cline consultation was aborted")
          if (result.exit.kind === "timeout") throw new Error(`Cline consultation timed out after ${timeoutMs}ms`)

          const parsed = parseClineJsonl(result.stdout)
          let sessionId = live.sessionId ?? parsed.sessionId
          const failure = externalTurnFailure({
            advisor: "Cline",
            exitCode: result.exit.code,
            completed: parsed.completed,
            error: parsed.error,
            answer: parsed.finalResponse,
            stderr: result.stderr,
          })
          log.info("turn validated advisor=cline success=" + !failure + " exit=" + result.exit.code)
          if (failure) throw new Error(failure)
          let body = parsed.finalResponse

          const started = intervention?.isActive() ?? false
          log.info("cline consult turn completed", {
            sessionID: ctx.sessionID,
            callID: ctx.callID,
            exitCode: result.exit.code,
            interventionActive: started,
          })
          const activeIntervention = intervention
          while (started && activeIntervention?.isActive()) {
            const command = yield* Effect.promise(() => activeIntervention.wait(ctx.abort))
            if (command.type === "abort") throw new Error("Cline consultation was aborted")
            if (command.type !== "message") break
            if (!sessionId) throw new Error("Cline did not return a session id for intervention")
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
                buildClineResumeArgs({
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
            if (result.exit.kind === "abort") throw new Error("Cline consultation was aborted")
            if (result.exit.kind === "timeout")
              throw new Error(`Cline consultation timed out after ${timeoutMs}ms`)
            const next = parseClineJsonl(result.stdout)
            const nextBody = next.finalResponse
            const nextError = externalTurnFailure({
              advisor: "Cline",
              exitCode: result.exit.code,
              completed: next.completed,
              error: next.error,
              answer: nextBody,
              stderr: result.stderr,
            })
            log.info("followup validated advisor=cline success=" + !nextError + " exit=" + result.exit.code)
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
            yield* publishMetadata(true)
          }

          intervention?.close()
          const header = [
            "<cline_consult>",
            "tools: full",
            `permission_mode: ${PERMISSION_MODE}`,
            `working_directory: ${workingDirectory}`,
            sessionId ? `session_id: ${sessionId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            "</cline_consult>",
          ]
            .filter(Boolean)
            .join("\n")
          return {
            title: "Cline execution",
            output: `${header}\n\n${body}`,
            metadata: {
              tools: TOOL_ACCESS,
              permission_mode: PERMISSION_MODE,
              working_directory: workingDirectory,
              prompt,
              session_id: sessionId,
              config_home: runtime.home,
              stop_reason: live.stopReason,
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

function upsertTranscript(state: ClineLiveState, item: ClineTranscriptItem) {
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

function closeAssistant(state: ClineLiveState, status = "completed") {
  if (!state.assistantOpen) return
  state.assistantOpen = false
  const id = `assistant:${state.assistantIndex}`
  const item = state.transcript.find((entry) => entry.id === id)
  if (item) {
    item.status = status
    state.onTranscript?.({ id: `${state.runSeq ?? 0}:${item.id}`, kind: item.kind, status: item.status })
  }
}

function closeThinking(state: ClineLiveState) {
  if (!state.thinkingOpen) return
  state.thinkingOpen = false
  const id = `thinking:${state.thinkingIndex}`
  const item = state.transcript.find((entry) => entry.id === id)
  if (item) {
    item.status = "completed"
    state.onTranscript?.({ id: `${state.runSeq ?? 0}:${item.id}`, kind: item.kind, status: item.status })
  }
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

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`
}
