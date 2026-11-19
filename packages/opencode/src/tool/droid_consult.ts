import path from "path"
import { Effect, Fiber, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./droid_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Config } from "@/config/config"
import { externalTurnFailure, resolveExternalCli } from "./external-cli"
import { registerAdvisorIntervention } from "./advisor-intervention"
import { attachExternalTranscript, type TranscriptItem } from "@/session/external"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.droid_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 120
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_TRANSCRIPT_TEXT = 8_000

const PERMISSION_MODE = "auto:high"
const TOOL_ACCESS = "full"
const DONE_REASONS = new Set(["completed", "end_turn", "stop", "success"])

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for local Factory Droid. Include goal, absolute paths, constraints, and the exact form of answer you need. Droid cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory Droid should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Droid model override (passed to `droid exec --model`).",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type DroidConsultParams = Schema.Schema.Type<typeof Parameters>

export type DroidExecBuildInput = {
  prompt: string
  workingDirectory: string
  model?: string
}

export type DroidTranscriptItem = {
  id: string
  kind: "message" | "user" | "tool_use" | "status" | "error" | "thinking"
  title?: string
  text?: string
  status?: string
}

export type DroidLiveState = {
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
  transcript: DroidTranscriptItem[]
  preview?: string
}

export type DroidJsonlParseResult = {
  completed: boolean
  stopReason?: string
  finalResponse: string
  sessionId?: string
  error?: string
  transcript: DroidTranscriptItem[]
  preview?: string
}

/** Build argv for a non-interactive `droid exec` run with high-autonomy tool access. */
export function buildDroidExecArgs(input: DroidExecBuildInput): string[] {
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

  const args = ["exec", "--output-format", "stream-json", "--auto", "high", "--cwd", input.workingDirectory]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  args.push(framed)
  return args
}

/** Resume an existing Droid session with the same headless JSON mode. */
export function buildDroidResumeArgs(input: DroidExecBuildInput & { sessionId: string }): string[] {
  const args = [
    "exec",
    "--output-format",
    "stream-json",
    "--auto",
    "high",
    "--cwd",
    input.workingDirectory,
    "--session-id",
    input.sessionId,
  ]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  args.push(input.prompt)
  return args
}

export function createDroidLiveState(): DroidLiveState {
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

export function beginDroidTurn(state: DroidLiveState) {
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

function assistantChunk(state: DroidLiveState, chunk: string) {
  if (!chunk) return
  closeThinking(state)
  if (!state.assistantOpen) {
    state.assistantOpen = true
    state.assistantIndex++
    state.assistantSegmentText = ""
  }
  // Stream may deliver either deltas or cumulative text for the open segment.
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
}

function thinkingChunk(state: DroidLiveState, text: string) {
  if (!text) return
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
}

function contentBlock(state: DroidLiveState, block: unknown, messageID: unknown, index: number) {
  if (!block || typeof block !== "object") return false
  const item = block as Record<string, unknown>
  const type = string(item.type) ?? ""
  const id =
    string(item.id) ?? `${type}:${string(messageID) ?? state.transcript.length}:${index}`

  if ((type === "text" || type === "output_text") && string(item.text)?.trim()) {
    const text = item.text as string
    if (state.assistantText && !state.assistantText.endsWith(text)) state.assistantText += text
    if (!state.assistantText) state.assistantText = text
    state.preview = state.assistantText
    closeThinking(state)
    if (!state.assistantOpen) {
      state.assistantOpen = true
      state.assistantIndex++
      state.assistantSegmentText = text
    }
    upsertTranscript(state, {
      id,
      kind: "message",
      title: "Assistant",
      text: state.onTranscript ? text : clip(text, MAX_TRANSCRIPT_TEXT),
      status: "completed",
    })
    return true
  }

  if (type === "tool_use" && string(item.name)) {
    closeThinking(state)
    closeAssistant(state)
    upsertTranscript(state, {
      id,
      kind: "tool_use",
      title: item.name as string,
      text: state.onTranscript ? stringify(item.input) : clip(stringify(item.input), MAX_TRANSCRIPT_TEXT),
      status: "running",
    })
    return true
  }

  if ((type === "thinking" || type === "redacted_thinking") && string(item.thinking)) {
    upsertTranscript(state, {
      id,
      kind: "thinking",
      title: "Thinking",
      text: state.onTranscript ? (item.thinking as string) : clip(item.thinking as string, MAX_TRANSCRIPT_TEXT),
      status: "completed",
    })
    return true
  }

  if (type === "tool_result") {
    const isError = item.is_error === true || item.isError === true
    const text = typeof item.content === "string" ? item.content : stringify(item.content)
    upsertTranscript(state, {
      id: `result:${id}`,
      kind: isError ? "error" : "status",
      title: "Tool result",
      text: state.onTranscript ? text : clip(text, MAX_TRANSCRIPT_TEXT),
      status: isError ? "error" : "completed",
    })
    return true
  }

  return false
}

/** Apply one `droid exec --output-format stream-json` event into live state. */
export function applyDroidJsonlLine(state: DroidLiveState, rawLine: string): boolean {
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

  // stream-json emits JSON-RPC-style notification envelopes; unwrap them.
  let type = string(item.type) ?? ""
  let payload = item
  if (type === "notification") {
    const inner = (item.notification ?? item.params) as Record<string, unknown> | undefined
    if (!inner || typeof inner !== "object") return false
    const method = string(item.method)
    type = string(inner.type) ?? (method ? method.replace(/^droid\./, "") : "")
    payload = inner
  } else if (type === "response" || type === "request") {
    return false
  }
  if (type.startsWith("droid.")) type = type.slice("droid.".length)
  if (type.startsWith("droid_") && type !== "droid_working_state_changed") type = type.slice("droid_".length)

  const sessionId = string(payload.sessionId) ?? string(payload.session_id)
  if (sessionId) state.sessionId = sessionId

  if (type === "create_message" || type === "message") {
    const message = (payload.message ?? payload) as Record<string, unknown>
    const contents = Array.isArray(message.content) ? message.content : []
    let changed = false
    for (const [index, block] of contents.entries()) {
      if (contentBlock(state, block, message.id ?? payload.messageId, index)) changed = true
    }
    return changed
  }

  if (type === "assistant_text_delta" || type === "text_delta") {
    assistantChunk(state, string(payload.textDelta) ?? string(payload.delta) ?? string(payload.text) ?? "")
    return true
  }

  if (type === "assistant_text_complete" || type === "text_complete") {
    closeAssistant(state)
    return true
  }

  if (type === "thinking_text_delta" || type === "reasoning_delta") {
    thinkingChunk(state, string(payload.textDelta) ?? string(payload.delta) ?? string(payload.text) ?? "")
    return true
  }

  if (type === "thinking_text_complete" || type === "reasoning_complete") {
    closeThinking(state)
    return true
  }

  if (type === "assistant") {
    // Claude-style assistant message envelope, for forward compatibility.
    const message = (payload.message ?? payload) as Record<string, unknown>
    const contents = Array.isArray(message.content) ? message.content : []
    let changed = false
    for (const [index, block] of contents.entries()) {
      if (contentBlock(state, block, message.id, index)) changed = true
    }
    return changed
  }

  if (type === "tool_call" || type === "tool_use") {
    closeThinking(state)
    closeAssistant(state)
    const tool = ((payload.toolUse ?? payload.tool_use ?? payload) as Record<string, unknown>) ?? {}
    const id = string(tool.id) ?? `tool:${state.transcript.length}`
    const title = string(tool.name) ?? string(payload.title) ?? "Tool"
    upsertTranscript(state, {
      id,
      kind: "tool_use",
      title,
      text: state.onTranscript ? stringify(tool.input) : clip(stringify(tool.input), MAX_TRANSCRIPT_TEXT),
      status: "running",
    })
    return true
  }

  if (type === "tool_result" || type === "tool_execution_phase_changed") {
    const tool = (payload.toolUse ?? payload) as Record<string, unknown>
    const id = string(tool.id) ?? string(payload.toolUseId) ?? string(payload.messageId)
    if (!id) return false
    const index = state.transcript.findIndex((entry) => entry.id === id)
    const isError = payload.isError === true || payload.is_error === true
    const text = string(payload.text) ?? stringify(payload.content ?? payload.output)
    if (index < 0) {
      if (!text) return false
      upsertTranscript(state, {
        id: `result:${id}`,
        kind: isError ? "error" : "status",
        title: "Tool result",
        text: state.onTranscript ? text : clip(text, MAX_TRANSCRIPT_TEXT),
        status: isError ? "error" : "completed",
      })
      return true
    }
    if (type === "tool_result") {
      state.transcript[index]!.status = isError ? "error" : "completed"
      if (text) {
        const entry = state.transcript[index]!
        entry.text = clip(entry.text ? `${entry.text}\n${text}` : text, MAX_TRANSCRIPT_TEXT)
      }
    }
    state.onTranscript?.({ ...state.transcript[index]!, id: `${state.runSeq ?? 0}:${state.transcript[index]!.id}` })
    return true
  }

  if (type === "error") {
    closeThinking(state)
    const message = string(payload.message) ?? stringify(payload.error) ?? "Droid turn failed"
    state.error = message
    state.completed = false
    closeAssistant(state, "error")
    upsertTranscript(state, { id: `error:${state.transcript.length}`, kind: "error", title: "Error", text: message })
    return true
  }

  if (type === "agent_turn_completed" || type === "turn_completed" || type === "done") {
    closeThinking(state)
    const reason = (string(payload.reason) ?? string(payload.finishReason))
      ?.replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/-/g, "_")
      .toLowerCase()
    state.stopReason = reason
    const failed = reason ? !DONE_REASONS.has(reason) : false
    if (failed) state.error ??= "Droid turn stopped: " + reason
    state.completed = !failed && !state.error
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

  if (type === "result") {
    // `droid exec -o json` terminal object shape.
    closeThinking(state)
    const result = string(payload.result) ?? string(payload.text)
    if (result && !state.assistantText) state.assistantText = result
    if (state.assistantText) state.preview = state.assistantText
    const subtype = string(payload.subtype)?.toLowerCase()
    const isError = payload.is_error === true || (subtype ? subtype !== "success" : false)
    state.stopReason = subtype
    state.completed = !isError
    if (isError) state.error ??= result ?? "Droid turn failed"
    closeAssistant(state, state.completed ? "completed" : "error")
    upsertTranscript(state, {
      id: `result:${state.sessionId ?? state.transcript.length}`,
      kind: isError ? "error" : "status",
      title: isError ? "Turn failed" : "Turn completed",
      text: state.error,
      status: isError ? "error" : "completed",
    })
    return true
  }

  return false
}

export function parseDroidJsonl(stdout: string): DroidJsonlParseResult {
  const state = createDroidLiveState()
  for (const line of stdout.split(/\r?\n/)) applyDroidJsonlLine(state, line)
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

export const DroidConsultTool = Tool.define(
  "droid_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const configs = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: DroidConsultParams, ctx: Tool.Context) => {
        let intervention: ReturnType<typeof registerAdvisorIntervention> | undefined
        return Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)
          yield* ctx.ask({
            permission: "droid_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              model: params.model,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })
          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const runtime = resolveExternalCli("droid", (yield* configs.get()).external_agents?.droid)
          const bin = runtime.binary
          // Droid resolves ~/.factory under FACTORY_HOME_OVERRIDE (the home root,
          // not the config dir), so inject the resolved home's parent directory.
          const env = { ...runtime.env, FACTORY_HOME_OVERRIDE: path.dirname(runtime.home) }
          log.info("runtime resolved advisor=droid binary=" + bin + " home=" + runtime.home)
          const prompt = params.prompt.trim()
          if (!prompt) throw new Error("prompt must be a non-empty string")

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const live = createDroidLiveState()
          attachExternalTranscript(ctx, live)
          let lastMetaAt = 0
          let publishMetadata: (force?: boolean) => Effect.Effect<void>
          intervention = ctx.callID
            ? registerAdvisorIntervention({
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                advisor: "droid",
                onChange: () => void Effect.runPromise(publishMetadata(true)),
              })
            : undefined

          publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              yield* ctx.metadata({
                title: live.preview
                  ? `Droid: ${clip(live.preview, 80).replace(/\s+/g, " ")}`
                  : "Running Factory Droid",
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
                beginDroidTurn(live)
                log.info("process starting advisor=droid run=" + live.runSeq + " resume=" + args.includes("--session-id"))
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
                      for (const line of lines) if (applyDroidJsonlLine(live, line)) dirty = true
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
                if (lineBuffer.trim()) applyDroidJsonlLine(live, lineBuffer)
                if (!live.completed) {
                  closeThinking(live)
                  closeAssistant(live, "error")
                }
                yield* publishMetadata(true)
                log.info(
                  "process drained advisor=droid exit=" +
                    exit.code +
                    " completed=" +
                    live.completed +
                    " reason=" +
                    (live.stopReason ?? "missing"),
                )
                return { exit, stdout, stderr }
              }),
            ).pipe(Effect.orDie)

          log.info("starting droid consult", {
            bin,
            cwd: workingDirectory,
            model: params.model,
            timeoutMs,
          })
          let result = yield* runProcess(buildDroidExecArgs({ prompt, workingDirectory, model: params.model }))
          if (result.exit.kind === "abort") throw new Error("Droid consultation was aborted")
          if (result.exit.kind === "timeout") throw new Error(`Droid consultation timed out after ${timeoutMs}ms`)

          const parsed = parseDroidJsonl(result.stdout)
          let sessionId = live.sessionId ?? parsed.sessionId
          const failure = externalTurnFailure({
            advisor: "Droid",
            exitCode: result.exit.code,
            completed: parsed.completed,
            error: parsed.error,
            answer: parsed.finalResponse,
            stderr: result.stderr,
          })
          log.info("turn validated advisor=droid success=" + !failure + " exit=" + result.exit.code)
          if (failure) throw new Error(failure)
          let body = parsed.finalResponse

          const started = intervention?.isActive() ?? false
          log.info("droid consult turn completed", {
            sessionID: ctx.sessionID,
            callID: ctx.callID,
            exitCode: result.exit.code,
            interventionActive: started,
          })
          const activeIntervention = intervention
          while (started && activeIntervention?.isActive()) {
            const command = yield* Effect.promise(() => activeIntervention.wait(ctx.abort))
            if (command.type === "abort") throw new Error("Droid consultation was aborted")
            if (command.type !== "message") break
            if (!sessionId) throw new Error("Droid did not return a session id for intervention")
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
                buildDroidResumeArgs({
                  sessionId,
                  prompt: command.message,
                  workingDirectory,
                  model: params.model,
                }),
              )
            } finally {
              activeIntervention.setBusy(false)
              yield* publishMetadata(true)
            }
            if (result.exit.kind === "abort") throw new Error("Droid consultation was aborted")
            if (result.exit.kind === "timeout")
              throw new Error(`Droid consultation timed out after ${timeoutMs}ms`)
            const next = parseDroidJsonl(result.stdout)
            const nextBody = next.finalResponse
            const nextError = externalTurnFailure({
              advisor: "Droid",
              exitCode: result.exit.code,
              completed: next.completed,
              error: next.error,
              answer: nextBody,
              stderr: result.stderr,
            })
            log.info("followup validated advisor=droid success=" + !nextError + " exit=" + result.exit.code)
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
            "<droid_consult>",
            "tools: full",
            `permission_mode: ${PERMISSION_MODE}`,
            `working_directory: ${workingDirectory}`,
            sessionId ? `session_id: ${sessionId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            "</droid_consult>",
          ]
            .filter(Boolean)
            .join("\n")
          return {
            title: "Factory Droid execution",
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

function upsertTranscript(state: DroidLiveState, item: DroidTranscriptItem) {
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

function closeAssistant(state: DroidLiveState, status = "completed") {
  if (!state.assistantOpen) return
  state.assistantOpen = false
  const id = `assistant:${state.assistantIndex}`
  const item = state.transcript.find((entry) => entry.id === id)
  if (item) {
    item.status = status
    state.onTranscript?.({ id: `${state.runSeq ?? 0}:${item.id}`, kind: item.kind, status: item.status })
  }
}

function closeThinking(state: DroidLiveState) {
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
