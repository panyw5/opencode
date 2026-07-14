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
  usage?: {
    input_tokens: number
    cached_input_tokens: number
    output_tokens: number
    reasoning_output_tokens: number
  }
  error?: string
  agentMessages: string[]
}

/** Parse `codex exec --json` JSONL stdout into a final advisor response. */
export function parseCodexJsonl(stdout: string): CodexJsonlParseResult {
  const agentMessages: string[] = []
  let threadId: string | undefined
  let usage: CodexJsonlParseResult["usage"]
  let error: string | undefined

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!event || typeof event !== "object") continue
    const e = event as Record<string, unknown>
    const type = typeof e.type === "string" ? e.type : ""

    if (type === "thread.started" && typeof e.thread_id === "string") {
      threadId = e.thread_id
      continue
    }

    if (type === "turn.completed" && e.usage && typeof e.usage === "object") {
      const u = e.usage as Record<string, unknown>
      usage = {
        input_tokens: num(u.input_tokens),
        cached_input_tokens: num(u.cached_input_tokens),
        output_tokens: num(u.output_tokens),
        reasoning_output_tokens: num(u.reasoning_output_tokens),
      }
      continue
    }

    if (type === "turn.failed") {
      const err = e.error
      if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
        error = (err as { message: string }).message
      } else if (typeof err === "string") {
        error = err
      } else {
        error = "Codex turn failed"
      }
      continue
    }

    if (type === "item.completed" || type === "item.updated" || type === "item.started") {
      const item = e.item
      if (!item || typeof item !== "object") continue
      const it = item as Record<string, unknown>
      if (it.type === "agent_message" && typeof it.text === "string" && it.text.trim()) {
        // Prefer the last non-empty agent_message as finalResponse; keep distinct texts.
        if (!agentMessages.includes(it.text)) {
          agentMessages.push(it.text)
        }
      }
      if (it.type === "error" && typeof it.message === "string" && it.message.trim()) {
        error = it.message
      }
    }
  }

  const finalResponse = agentMessages.at(-1)?.trim() ?? ""
  return { finalResponse, threadId, usage, error, agentMessages }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
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

          yield* ctx.metadata({
            title: "Consulting Codex (read-only)",
            metadata: {
              bin,
              working_directory: workingDirectory,
              model: params.model,
              timeout_ms: timeoutMs,
              sandbox: "read-only",
            },
          })

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

              yield* Effect.forkScoped(
                Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                  Effect.sync(() => {
                    stdout += chunk
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

              return { exit, stdout, stderr }
            }),
          ).pipe(Effect.orDie)

          if (result.exit.kind === "abort") {
            throw new Error("Codex consultation was aborted")
          }
          if (result.exit.kind === "timeout") {
            throw new Error(`Codex consultation timed out after ${timeoutMs}ms`)
          }

          const parsed = parseCodexJsonl(result.stdout)
          const exitCode = result.exit.code

          if (parsed.error && !parsed.finalResponse) {
            throw new Error(`Codex failed: ${parsed.error}`)
          }

          if (exitCode !== 0 && !parsed.finalResponse) {
            const detail = (parsed.error || result.stderr || result.stdout).trim().slice(0, 4000)
            throw new Error(
              `Codex exited with code ${exitCode}${detail ? `: ${detail}` : ""}. Ensure \`codex\` is authenticated and the custom provider (if any) is reachable.`,
            )
          }

          const body =
            parsed.finalResponse ||
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
            parsed.threadId ? `thread_id: ${parsed.threadId}` : undefined,
            params.model ? `model: ${params.model}` : undefined,
            parsed.usage
              ? `tokens: in=${parsed.usage.input_tokens} out=${parsed.usage.output_tokens} reasoning=${parsed.usage.reasoning_output_tokens}`
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
              thread_id: parsed.threadId,
              model: params.model,
              usage: parsed.usage,
              exit_code: exitCode,
            },
          }
        }),
    }
  }),
)

function resolveWorkingDirectory(input: string | undefined, projectDirectory: string): string {
  if (!input?.trim()) return projectDirectory
  const resolved = path.isAbsolute(input) ? path.normalize(input) : path.resolve(projectDirectory, input)
  return resolved
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "")
}
