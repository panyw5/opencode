import path from "path"
import { Effect, Fiber, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./claude_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { which } from "@/util/which"
import { registerAdvisorIntervention } from "./advisor-intervention"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.claude_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 120
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_TRANSCRIPT_TEXT = 8_000

const READ_ONLY_TOOLS = "Read,Grep,Glob,LS"

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for Claude. Include goal, absolute paths, constraints, and the exact form of answer you need. Claude cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory Claude should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Claude model override (passed to `claude --model`).",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type ClaudeConsultParams = Schema.Schema.Type<typeof Parameters>

export type ClaudeExecBuildInput = {
  prompt: string
  workingDirectory: string
  model?: string
}

export function buildClaudeResumeArgs(input: {
  sessionId: string
  prompt: string
  workingDirectory: string
  model?: string
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--permission-mode",
    "dontAsk",
    "--safe-mode",
    "--tools",
    READ_ONLY_TOOLS,
    "--add-dir",
    input.workingDirectory,
    "--resume",
    input.sessionId,
  ]
  if (input.model?.trim()) args.push("--model", input.model.trim())
  args.push(input.prompt)
  return args
}

export type ClaudeTranscriptItem = {
  id: string
  kind: "message" | "user" | "tool_use" | "tool_result" | "status" | "error" | "thinking"
  title?: string
  text?: string
  status?: string
}

export type ClaudeLiveState = {
  sessionId?: string
  usage?: Record<string, unknown>
  costUsd?: number
  durationMs?: number
  error?: string
  agentMessages: string[]
  transcript: ClaudeTranscriptItem[]
  preview?: string
}

/** Build argv for a read-only one-shot `claude -p` consult (shared with tests). */
export function buildClaudeExecArgs(input: ClaudeExecBuildInput): string[] {
  const framed = [
    "You are an external advisor consulted by OpenCode.",
    "Operate read-only: do not attempt to modify files.",
    "Return analysis, risks, alternatives, and concrete recommendations.",
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
    "dontAsk",
    "--safe-mode",
    "--tools",
    READ_ONLY_TOOLS,
    "--add-dir",
    input.workingDirectory,
  ]
  if (input.model?.trim()) {
    args.push("--model", input.model.trim())
  }
  args.push(framed)
  return args
}

export type ClaudeJsonlParseResult = {
  finalResponse: string
  sessionId?: string
  usage?: ClaudeLiveState["usage"]
  costUsd?: number
  durationMs?: number
  error?: string
  agentMessages: string[]
  transcript: ClaudeTranscriptItem[]
  preview?: string
}

export function createClaudeLiveState(): ClaudeLiveState {
  return { agentMessages: [], transcript: [] }
}

/** Apply one `claude -p --output-format stream-json` JSONL event into live state. */
export function applyClaudeJsonlLine(state: ClaudeLiveState, rawLine: string): boolean {
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
    for (const content of contents) {
      if (!content || typeof content !== "object") continue
      const item = content as Record<string, unknown>
      const itemType = typeof item.type === "string" ? item.type : ""
      const id = typeof item.id === "string" && item.id ? item.id : `${itemType}:${state.transcript.length}`

      if (itemType === "text" && typeof item.text === "string" && item.text.trim()) {
        if (!state.agentMessages.includes(item.text)) state.agentMessages.push(item.text)
        state.preview = item.text
        upsertTranscript(state, {
          id,
          kind: "message",
          title: "Assistant",
          text: clip(item.text, MAX_TRANSCRIPT_TEXT),
          status: "completed",
        })
        changed = true
      }

      if ((itemType === "tool_use" || itemType === "server_tool_use") && typeof item.name === "string") {
        upsertTranscript(state, {
          id,
          kind: "tool_use",
          title: item.name,
          text: clip(stringify(item.input), MAX_TRANSCRIPT_TEXT),
          status: "running",
        })
        changed = true
      }

      if ((itemType === "thinking" || itemType === "redacted_thinking") && typeof item.thinking === "string") {
        upsertTranscript(state, {
          id,
          kind: "thinking",
          title: "Thinking",
          text: clip(item.thinking, MAX_TRANSCRIPT_TEXT),
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
        text: clip(text, MAX_TRANSCRIPT_TEXT),
        status: isError ? "error" : "completed",
      })
      if (isError && text) state.error = text
      changed = true
    }
    return changed
  }

  if (type === "result") {
    const resultText = typeof e.result === "string" ? e.result.trim() : ""
    const isError = e.is_error === true || e.subtype === "error"
    state.usage = readObject(e.usage) ?? state.usage
    state.costUsd = typeof e.total_cost_usd === "number" ? e.total_cost_usd : state.costUsd
    state.durationMs = typeof e.duration_ms === "number" ? e.duration_ms : state.durationMs
    if (resultText && !state.agentMessages.includes(resultText)) state.agentMessages.push(resultText)
    if (resultText) state.preview = resultText
    if (isError) state.error = resultText || "Claude turn failed"
    upsertTranscript(state, {
      id: `result:${state.sessionId ?? state.transcript.length}`,
      kind: isError ? "error" : "status",
      title: isError ? "Turn failed" : "Turn completed",
      text: resultText ? clip(resultText, MAX_TRANSCRIPT_TEXT) : undefined,
      status: isError ? "error" : "completed",
    })
    return true
  }

  if (type === "error") {
    const message = typeof e.message === "string" ? e.message : stringify(e.error) || "Claude turn failed"
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

/** Parse full `claude -p --output-format stream-json` JSONL stdout. */
export function parseClaudeJsonl(stdout: string): ClaudeJsonlParseResult {
  const state = createClaudeLiveState()
  for (const raw of stdout.split(/\r?\n/)) {
    applyClaudeJsonlLine(state, raw)
  }
  const finalResponse = state.agentMessages.at(-1)?.trim() ?? ""
  return {
    finalResponse,
    sessionId: state.sessionId,
    usage: state.usage,
    costUsd: state.costUsd,
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

export const ClaudeConsultTool = Tool.define(
  "claude_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: ClaudeConsultParams, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)

          yield* ctx.ask({
            permission: "claude_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              model: params.model,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })

          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const bin = which("claude")
          if (!bin) {
            throw new Error(
              [
                "Claude CLI not found on PATH.",
                "Install Claude Code and ensure `claude` is available on PATH.",
                "Then authenticate and retry.",
              ].join(" "),
            )
          }

          const prompt = params.prompt.trim()
          if (!prompt) {
            throw new Error("prompt must be a non-empty string")
          }

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const args = buildClaudeExecArgs({
            prompt,
            workingDirectory,
            model: params.model,
          })

          const live = createClaudeLiveState()
          let lastMetaAt = 0

          const publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              yield* ctx.metadata({
                title: live.preview
                  ? `Claude: ${clip(live.preview, 80).replace(/\s+/g, " ")}`
                  : "Consulting Claude (read-only)",
                metadata: {
                  bin,
                  working_directory: workingDirectory,
                  model: params.model,
                  timeout_ms: timeoutMs,
                  tools: READ_ONLY_TOOLS,
                  permission_mode: "dontAsk",
                  safe_mode: true,
                  prompt,
                  session_id: live.sessionId,
                  preview: live.preview,
                  transcript: live.transcript.slice(),
                  usage: live.usage,
                  cost_usd: live.costUsd,
                  duration_ms: live.durationMs,
                  intervention: intervention?.snapshot(),
                },
              })
            })

          const intervention = ctx.callID
            ? registerAdvisorIntervention({
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                advisor: "claude",
                onChange: () => void Effect.runPromise(publishMetadata(true)),
              })
            : undefined

          yield* publishMetadata(true)

          log.info("starting claude consult", {
            bin,
            cwd: workingDirectory,
            model: params.model,
            timeoutMs,
          })

          const runProcess = (runArgs: string[]) =>
            Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* spawner.spawn(
                  ChildProcess.make(bin, runArgs, {
                    cwd: workingDirectory,
                    extendEnv: true,
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
                        if (applyClaudeJsonlLine(live, part)) dirty = true
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
                yield* Fiber.join(stdoutFiber)
                yield* Fiber.join(stderrFiber)

                // Flush a final unterminated JSONL event, then make it visible immediately.
                if (lineBuffer.trim()) applyClaudeJsonlLine(live, lineBuffer)
                yield* publishMetadata(true)

                return { exit, stdout, stderr }
              }),
            ).pipe(Effect.orDie)

          const result = yield* runProcess(args)

          if (result.exit.kind === "abort") {
            upsertTranscript(live, {
              id: `aborted:${Date.now()}`,
              kind: "status",
              title: "Stopped",
              text: "Claude consultation was aborted",
            })
            yield* publishMetadata(true)
            throw new Error("Claude consultation was aborted")
          }
          if (result.exit.kind === "timeout") {
            throw new Error(`Claude consultation timed out after ${timeoutMs}ms`)
          }

          const parsed = parseClaudeJsonl(result.stdout)
          const exitCode = result.exit.code
          let sessionId = live.sessionId ?? parsed.sessionId
          let usage = live.usage ?? parsed.usage
          let costUsd = live.costUsd ?? parsed.costUsd
          let durationMs = live.durationMs ?? parsed.durationMs
          const error = live.error ?? parsed.error
          let transcript = live.transcript.length ? live.transcript : parsed.transcript
          const finalResponse = (live.agentMessages.at(-1) ?? parsed.finalResponse)?.trim() || parsed.finalResponse

          if (error && !finalResponse) {
            throw new Error(`Claude failed: ${error}`)
          }

          if (exitCode !== 0 && !finalResponse) {
            const detail = (error || result.stderr || result.stdout).trim().slice(0, 4000)
            throw new Error(
              `Claude exited with code ${exitCode}${detail ? `: ${detail}` : ""}. Ensure \`claude\` is authenticated and reachable.`,
            )
          }

          let body = finalResponse || stripAnsi(result.stdout).trim() || stripAnsi(result.stderr).trim()

          if (!body) {
            throw new Error("Claude returned an empty response")
          }

          const started = intervention?.isActive() ?? false
          log.info("claude consult turn completed", {
            sessionID: ctx.sessionID,
            callID: ctx.callID,
            exitCode,
            interventionActive: started,
          })
          while (started && intervention?.isActive()) {
            const command = yield* Effect.promise(() => intervention.wait(ctx.abort))
            if (command.type === "abort") throw new Error("Claude consultation was aborted")
            if (command.type !== "message") break
            if (!sessionId) throw new Error("Claude did not return a session id for intervention")

            upsertTranscript(live, {
              id: `intervention-user:${Date.now()}`,
              kind: "user",
              title: "User",
              text: command.message,
              status: "completed",
            })
            intervention.setBusy(true)
            const messageCount = live.agentMessages.length
            let next: { exit: { kind: string; code: number | null }; stdout: string; stderr: string }
            try {
              next = yield* runProcess(
                buildClaudeResumeArgs({
                  sessionId,
                  prompt: command.message,
                  workingDirectory,
                  model: params.model,
                }),
              )
            } finally {
              intervention.setBusy(false)
              yield* publishMetadata(true)
            }
            if (next.exit.kind === "abort") throw new Error("Claude consultation was aborted")
            if (next.exit.kind === "timeout") throw new Error(`Claude consultation timed out after ${timeoutMs}ms`)
            const nextParsed = parseClaudeJsonl(next.stdout)
            const nextError = nextParsed.error
            const nextBody =
              (live.agentMessages.slice(messageCount).at(-1) ?? nextParsed.finalResponse)?.trim() ||
              stripAnsi(next.stdout).trim() ||
              stripAnsi(next.stderr).trim()
            if (nextError && !nextBody) {
              upsertTranscript(live, {
                id: `intervention-error:${Date.now()}`,
                kind: "error",
                title: "Error",
                text: clip(`Claude failed: ${nextError}`, MAX_TRANSCRIPT_TEXT),
                status: "error",
              })
              yield* publishMetadata(true)
              continue
            }
            if (!nextBody) {
              upsertTranscript(live, {
                id: `intervention-error:${Date.now()}`,
                kind: "error",
                title: "Error",
                text: "Claude returned an empty response",
                status: "error",
              })
              yield* publishMetadata(true)
              continue
            }
            if (!live.agentMessages.includes(nextBody)) live.agentMessages.push(nextBody)
            live.preview = nextBody
            if (
              !live.transcript.some(
                (item) => item.kind === "message" && item.text === clip(nextBody, MAX_TRANSCRIPT_TEXT),
              )
            ) {
              upsertTranscript(live, {
                id: `intervention-assistant:${Date.now()}`,
                kind: "message",
                title: "Assistant",
                text: clip(nextBody, MAX_TRANSCRIPT_TEXT),
                status: "completed",
              })
            }
            body = nextBody
            sessionId = live.sessionId ?? nextParsed.sessionId ?? sessionId
            usage = live.usage ?? nextParsed.usage ?? usage
            costUsd = live.costUsd ?? nextParsed.costUsd ?? costUsd
            durationMs = live.durationMs ?? nextParsed.durationMs ?? durationMs
            transcript = live.transcript.length ? live.transcript : nextParsed.transcript
            yield* publishMetadata(true)
          }

          intervention?.close()

          const header = [
            "<claude_consult>",
            "tools: read-only",
            "permission_mode: dontAsk",
            "safe_mode: true",
            `working_directory: ${workingDirectory}`,
            sessionId ? `session_id: ${sessionId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            typeof costUsd === "number" ? `cost_usd: ${costUsd}` : undefined,
            typeof durationMs === "number" ? `duration_ms: ${durationMs}` : undefined,
            "</claude_consult>",
          ]
            .filter(Boolean)
            .join("\n")

          return {
            title: "Claude consult (read-only)",
            output: `${header}\n\n${body}`,
            metadata: {
              tools: READ_ONLY_TOOLS,
              permission_mode: "dontAsk" as const,
              safe_mode: true,
              working_directory: workingDirectory,
              prompt,
              session_id: sessionId,
              model: params.model,
              usage,
              cost_usd: costUsd,
              duration_ms: durationMs,
              exit_code: exitCode,
              preview: body,
              transcript,
            },
          }
        }),
    }
  }),
)

function upsertTranscript(state: ClaudeLiveState, item: ClaudeTranscriptItem) {
  const idx = state.transcript.findIndex((entry) => entry.id === item.id)
  if (idx >= 0) {
    state.transcript[idx] = { ...state.transcript[idx], ...item }
  } else {
    state.transcript.push(item)
    if (state.transcript.length > MAX_TRANSCRIPT_ITEMS) {
      state.transcript.splice(0, state.transcript.length - MAX_TRANSCRIPT_ITEMS)
    }
  }
}

function resolveWorkingDirectory(input: string | undefined, projectDirectory: string): string {
  if (!input?.trim()) return projectDirectory
  const resolved = path.isAbsolute(input) ? path.normalize(input) : path.resolve(projectDirectory, input)
  return resolved
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "")
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
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

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}
