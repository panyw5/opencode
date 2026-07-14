import path from "path"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./codex_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { which } from "@/util/which"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.codex_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 120
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_TRANSCRIPT_TEXT = 8_000

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for Codex. Include goal, absolute paths, constraints, and the exact form of answer you need. Codex cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory Codex should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional Codex model override (passed to `codex exec -m`).",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type CodexConsultParams = Schema.Schema.Type<typeof Parameters>

export type CodexExecBuildInput = {
  prompt: string
  workingDirectory: string
  model?: string
}

export type CodexTranscriptItem = {
  id: string
  kind: "message" | "command" | "reasoning" | "file_change" | "web_search" | "todo" | "error" | "status" | "mcp"
  title?: string
  text?: string
  status?: string
}

export type CodexLiveState = {
  threadId?: string
  usage?: {
    input_tokens: number
    cached_input_tokens: number
    output_tokens: number
    reasoning_output_tokens: number
  }
  error?: string
  agentMessages: string[]
  transcript: CodexTranscriptItem[]
  preview?: string
}

/** Build argv for a read-only one-shot `codex exec` (shared with tests). */
export function buildCodexExecArgs(input: CodexExecBuildInput): string[] {
  const framed = [
    "You are an external advisor consulted by OpenCode.",
    "Sandbox is read-only: do not attempt to modify files.",
    "Return analysis, risks, alternatives, and concrete recommendations.",
    "Be concise and structured.",
    "",
    "Consultation request:",
    input.prompt,
  ].join("\n")

  const args = [
    "exec",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    input.workingDirectory,
    // Non-interactive: never block on approval UI.
    "-c",
    'approval_policy="never"',
    "--json",
  ]
  if (input.model?.trim()) {
    args.push("-m", input.model.trim())
  }
  args.push(framed)
  return args
}

export type CodexJsonlParseResult = {
  finalResponse: string
  threadId?: string
  usage?: CodexLiveState["usage"]
  error?: string
  agentMessages: string[]
  transcript: CodexTranscriptItem[]
  preview?: string
}

export function createCodexLiveState(): CodexLiveState {
  return { agentMessages: [], transcript: [] }
}

/** Apply one `codex exec --json` JSONL event into live state (for streaming + final parse). */
export function applyCodexJsonlLine(state: CodexLiveState, rawLine: string): boolean {
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
  let changed = false

  if (type === "thread.started" && typeof e.thread_id === "string") {
    if (state.threadId !== e.thread_id) {
      state.threadId = e.thread_id
      upsertTranscript(state, {
        id: `thread:${e.thread_id}`,
        kind: "status",
        title: "Thread started",
        text: e.thread_id,
      })
      changed = true
    }
    return changed
  }

  if (type === "turn.started") {
    upsertTranscript(state, {
      id: `turn-start:${state.transcript.length}`,
      kind: "status",
      title: "Turn started",
    })
    return true
  }

  if (type === "turn.completed" && e.usage && typeof e.usage === "object") {
    const u = e.usage as Record<string, unknown>
    state.usage = {
      input_tokens: num(u.input_tokens),
      cached_input_tokens: num(u.cached_input_tokens),
      output_tokens: num(u.output_tokens),
      reasoning_output_tokens: num(u.reasoning_output_tokens),
    }
    upsertTranscript(state, {
      id: `turn-complete:${state.transcript.length}`,
      kind: "status",
      title: "Turn completed",
      text: `in=${state.usage.input_tokens} out=${state.usage.output_tokens}`,
    })
    return true
  }

  if (type === "turn.failed") {
    const err = e.error
    if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
      state.error = (err as { message: string }).message
    } else if (typeof err === "string") {
      state.error = err
    } else {
      state.error = "Codex turn failed"
    }
    upsertTranscript(state, {
      id: `turn-failed:${state.transcript.length}`,
      kind: "error",
      title: "Turn failed",
      text: state.error,
    })
    return true
  }

  if (type === "item.completed" || type === "item.updated" || type === "item.started") {
    const item = e.item
    if (!item || typeof item !== "object") return false
    const it = item as Record<string, unknown>
    const id = typeof it.id === "string" && it.id ? it.id : `item:${state.transcript.length}`
    const itemType = typeof it.type === "string" ? it.type : ""

    if (itemType === "agent_message" && typeof it.text === "string" && it.text.trim()) {
      if (!state.agentMessages.includes(it.text)) state.agentMessages.push(it.text)
      state.preview = it.text
      upsertTranscript(state, {
        id,
        kind: "message",
        title: "Assistant",
        text: clip(it.text, MAX_TRANSCRIPT_TEXT),
        status: type === "item.started" ? "running" : "completed",
      })
      return true
    }

    if (itemType === "reasoning" && typeof it.text === "string" && it.text.trim()) {
      upsertTranscript(state, {
        id,
        kind: "reasoning",
        title: "Reasoning",
        text: clip(it.text, MAX_TRANSCRIPT_TEXT),
        status: type === "item.started" ? "running" : "completed",
      })
      return true
    }

    if (itemType === "command_execution") {
      const command = typeof it.command === "string" ? it.command : "command"
      const output = typeof it.aggregated_output === "string" ? it.aggregated_output : ""
      const status = typeof it.status === "string" ? it.status : type === "item.started" ? "running" : "completed"
      upsertTranscript(state, {
        id,
        kind: "command",
        title: command,
        text: clip(output, MAX_TRANSCRIPT_TEXT),
        status,
      })
      return true
    }

    if (itemType === "file_change") {
      const status = typeof it.status === "string" ? it.status : "completed"
      const changes = Array.isArray(it.changes) ? it.changes : []
      const summary = changes
        .map((change) => {
          if (!change || typeof change !== "object") return ""
          const c = change as Record<string, unknown>
          return `${String(c.kind ?? "update")} ${String(c.path ?? "")}`.trim()
        })
        .filter(Boolean)
        .join("\n")
      upsertTranscript(state, {
        id,
        kind: "file_change",
        title: "File changes",
        text: clip(summary || status, MAX_TRANSCRIPT_TEXT),
        status,
      })
      return true
    }

    if (itemType === "web_search") {
      const query = typeof it.query === "string" ? it.query : "web search"
      upsertTranscript(state, {
        id,
        kind: "web_search",
        title: "Web search",
        text: query,
        status: type === "item.started" ? "running" : "completed",
      })
      return true
    }

    if (itemType === "todo_list") {
      const items = Array.isArray(it.items) ? it.items : []
      const text = items
        .map((entry) => {
          if (!entry || typeof entry !== "object") return ""
          const t = entry as Record<string, unknown>
          const done = t.completed === true ? "[x]" : "[ ]"
          return `${done} ${String(t.text ?? "")}`.trim()
        })
        .filter(Boolean)
        .join("\n")
      upsertTranscript(state, {
        id,
        kind: "todo",
        title: "Todo",
        text: clip(text, MAX_TRANSCRIPT_TEXT),
      })
      return true
    }

    if (itemType === "mcp_tool_call") {
      const server = typeof it.server === "string" ? it.server : "mcp"
      const tool = typeof it.tool === "string" ? it.tool : "tool"
      const status = typeof it.status === "string" ? it.status : type === "item.started" ? "running" : "completed"
      const err =
        it.error && typeof it.error === "object" && typeof (it.error as { message?: unknown }).message === "string"
          ? (it.error as { message: string }).message
          : undefined
      upsertTranscript(state, {
        id,
        kind: "mcp",
        title: `${server}/${tool}`,
        text: err,
        status,
      })
      return true
    }

    if (itemType === "error" && typeof it.message === "string" && it.message.trim()) {
      state.error = it.message
      upsertTranscript(state, {
        id,
        kind: "error",
        title: "Error",
        text: it.message,
      })
      return true
    }
  }

  return changed
}

/** Parse full `codex exec --json` JSONL stdout. */
export function parseCodexJsonl(stdout: string): CodexJsonlParseResult {
  const state = createCodexLiveState()
  for (const raw of stdout.split(/\r?\n/)) {
    applyCodexJsonlLine(state, raw)
  }
  const finalResponse = state.agentMessages.at(-1)?.trim() ?? ""
  return {
    finalResponse,
    threadId: state.threadId,
    usage: state.usage,
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

export const CodexConsultTool = Tool.define(
  "codex_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: CodexConsultParams, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)

          yield* ctx.ask({
            permission: "codex_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              model: params.model,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })

          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const bin = which("codex")
          if (!bin) {
            throw new Error(
              [
                "Codex CLI not found on PATH.",
                "Install with: npm install -g @openai/codex",
                "Then authenticate (codex login) and retry.",
              ].join(" "),
            )
          }

          const prompt = params.prompt.trim()
          if (!prompt) {
            throw new Error("prompt must be a non-empty string")
          }

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const args = buildCodexExecArgs({
            prompt,
            workingDirectory,
            model: params.model,
          })

          const live = createCodexLiveState()
          let lastMetaAt = 0

          const publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              yield* ctx.metadata({
                title: live.preview
                  ? `Codex: ${clip(live.preview, 80).replace(/\s+/g, " ")}`
                  : "Consulting Codex (read-only)",
                metadata: {
                  bin,
                  working_directory: workingDirectory,
                  model: params.model,
                  timeout_ms: timeoutMs,
                  sandbox: "read-only",
                  prompt,
                  thread_id: live.threadId,
                  preview: live.preview,
                  transcript: live.transcript.slice(),
                  usage: live.usage,
                },
              })
            })

          yield* publishMetadata(true)

          log.info("starting codex consult", {
            bin,
            cwd: workingDirectory,
            model: params.model,
            timeoutMs,
          })

          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(bin, args, {
                  cwd: workingDirectory,
                  extendEnv: true,
                  stdin: "ignore",
                }),
              )

              let stdout = ""
              let stderr = ""
              let lineBuffer = ""

              yield* Effect.forkScoped(
                Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                  Effect.gen(function* () {
                    stdout += chunk
                    lineBuffer += chunk
                    const parts = lineBuffer.split(/\r?\n/)
                    lineBuffer = parts.pop() ?? ""
                    let dirty = false
                    for (const part of parts) {
                      if (applyCodexJsonlLine(live, part)) dirty = true
                    }
                    if (dirty) yield* publishMetadata()
                  }),
                ),
              )
              yield* Effect.forkScoped(
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

              // Flush trailing partial line if any complete JSON remains.
              if (lineBuffer.trim()) applyCodexJsonlLine(live, lineBuffer)

              return { exit, stdout, stderr }
            }),
          ).pipe(Effect.orDie)

          if (result.exit.kind === "abort") {
            upsertTranscript(live, {
              id: `aborted:${Date.now()}`,
              kind: "status",
              title: "Stopped",
              text: "Codex consultation was aborted",
            })
            yield* publishMetadata(true)
            throw new Error("Codex consultation was aborted")
          }
          if (result.exit.kind === "timeout") {
            throw new Error(`Codex consultation timed out after ${timeoutMs}ms`)
          }

          // Prefer streamed state; re-parse full stdout as a safety net.
          const parsed = parseCodexJsonl(result.stdout)
          const exitCode = result.exit.code
          const threadId = live.threadId ?? parsed.threadId
          const usage = live.usage ?? parsed.usage
          const error = live.error ?? parsed.error
          const transcript = live.transcript.length ? live.transcript : parsed.transcript
          const finalResponse =
            (live.agentMessages.at(-1) ?? parsed.finalResponse)?.trim() || parsed.finalResponse

          if (error && !finalResponse) {
            throw new Error(`Codex failed: ${error}`)
          }

          if (exitCode !== 0 && !finalResponse) {
            const detail = (error || result.stderr || result.stdout).trim().slice(0, 4000)
            throw new Error(
              `Codex exited with code ${exitCode}${detail ? `: ${detail}` : ""}. Ensure \`codex\` is authenticated and the custom provider (if any) is reachable.`,
            )
          }

          const body =
            finalResponse ||
            // Fallback: non-JSON noise or plain text mode
            stripAnsi(result.stdout).trim() ||
            stripAnsi(result.stderr).trim()

          if (!body) {
            throw new Error("Codex returned an empty response")
          }

          const header = [
            "<codex_consult>",
            `sandbox: read-only`,
            `working_directory: ${workingDirectory}`,
            threadId ? `thread_id: ${threadId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            usage
              ? `tokens: in=${usage.input_tokens} out=${usage.output_tokens} reasoning=${usage.reasoning_output_tokens}`
              : undefined,
            "</codex_consult>",
          ]
            .filter(Boolean)
            .join("\n")

          return {
            title: "Codex consult (read-only)",
            output: `${header}\n\n${body}`,
            metadata: {
              sandbox: "read-only" as const,
              working_directory: workingDirectory,
              prompt,
              thread_id: threadId,
              model: params.model,
              usage,
              exit_code: exitCode,
              preview: body,
              transcript,
            },
          }
        }),
    }
  }),
)

function upsertTranscript(state: CodexLiveState, item: CodexTranscriptItem) {
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
  return `${text.slice(0, max)}…`
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
