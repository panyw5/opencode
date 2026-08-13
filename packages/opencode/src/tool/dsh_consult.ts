import path from "path"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "./tool"
import DESCRIPTION from "./dsh_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { which } from "@/util/which"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.dsh_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 200
const MAX_PREVIEW = 8_000

export const Parameters = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "Self-contained consultation prompt for DeepSeek Harness (dsh). Include goal, absolute paths, constraints, and the exact form of answer you need. dsh cannot see this conversation.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description:
      "Absolute directory dsh should run in. Defaults to the current project directory. Must stay inside an allowed workspace path.",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
})

export type DshConsultParams = Schema.Schema.Type<typeof Parameters>

export type DshExecBuildInput = {
  prompt: string
}

/** Build argv for a one-shot `dsh --profile headless` consult. */
export function buildDshExecArgs(input: DshExecBuildInput): string[] {
  const framed = [
    "You are an external advisor consulted by OpenCode.",
    "Prefer analysis, risks, alternatives, and concrete recommendations.",
    "Avoid unnecessary file modifications unless the request explicitly requires implementation.",
    "Be concise and structured.",
    "",
    "Consultation request:",
    input.prompt,
  ].join("\n")

  return ["--profile", "headless", framed]
}

export function resolveTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)))
}

/** Detect credential / runner failures that may still exit 0 with empty stdout. */
export function classifyDshFailure(input: {
  exitCode: number | null
  stdout: string
  stderr: string
}): string | undefined {
  const stdout = stripAnsi(input.stdout).trim()
  const stderr = stripAnsi(input.stderr).trim()
  const detail = stderr || stdout

  if (input.exitCode !== null && input.exitCode !== 0) {
    return `dsh exited with code ${input.exitCode}${detail ? `: ${clip(detail, 4000)}` : ""}`
  }

  if (/MISSING_CREDENTIAL|no API key|llm-deepseek/i.test(stderr)) {
    return [
      "dsh has no API credentials.",
      "Export DEEPSEEK_API_KEY, or configure a key via the dsh web Models page (~/.dsh).",
      detail ? `Detail: ${clip(detail, 2000)}` : undefined,
    ]
      .filter(Boolean)
      .join(" ")
  }

  if (/^dsh:\s+/m.test(stderr) && !stdout) {
    return clip(stderr, 4000)
  }

  if (!stdout) {
    return detail
      ? `dsh returned empty stdout: ${clip(detail, 4000)}`
      : "dsh returned an empty response"
  }

  return undefined
}

export const DshConsultTool = Tool.define(
  "dsh_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: DshConsultParams, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const workingDirectory = resolveWorkingDirectory(params.working_directory, ins.directory)

          yield* ctx.ask({
            permission: "dsh_consult",
            patterns: [workingDirectory],
            always: ["*"],
            metadata: {
              working_directory: workingDirectory,
              prompt_preview: params.prompt.slice(0, 200),
            },
          })

          yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })

          const bin = which("dsh")
          if (!bin) {
            throw new Error(
              [
                "DeepSeek Harness CLI (`dsh`) not found on PATH.",
                "Install with: npm i -g @deepseek-ai/dsh",
                "Then export DEEPSEEK_API_KEY (or configure credentials under ~/.dsh) and retry.",
              ].join(" "),
            )
          }

          const prompt = params.prompt.trim()
          if (!prompt) throw new Error("prompt must be a non-empty string")

          const timeoutMs = resolveTimeoutMs(params.timeout_ms)
          const args = buildDshExecArgs({ prompt })

          let stdout = ""
          let stderr = ""
          let lastMetaAt = 0

          const publishMetadata = (force = false) =>
            Effect.gen(function* () {
              const now = Date.now()
              if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
              lastMetaAt = now
              const preview = stripAnsi(stdout).trim()
              yield* ctx.metadata({
                title: preview
                  ? `DeepSeek: ${clip(preview, 80).replace(/\s+/g, " ")}`
                  : "Consulting DeepSeek Harness",
                metadata: {
                  bin,
                  working_directory: workingDirectory,
                  timeout_ms: timeoutMs,
                  profile: "headless",
                  prompt,
                  preview: preview ? clip(preview, MAX_PREVIEW) : undefined,
                  transcript: preview
                    ? [
                        {
                          id: "assistant:final",
                          kind: "message" as const,
                          title: "Assistant",
                          text: clip(preview, MAX_PREVIEW),
                          status: "running" as const,
                        },
                      ]
                    : [],
                },
              })
            })

          yield* publishMetadata(true)

          log.info("starting dsh consult", { bin, cwd: workingDirectory, timeoutMs })

          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(bin, args, {
                  cwd: workingDirectory,
                  extendEnv: true,
                  stdin: "ignore",
                }),
              )

              yield* Effect.forkScoped(
                Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                  Effect.gen(function* () {
                    stdout += chunk
                    yield* publishMetadata()
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

              if (exit.kind !== "exit") {
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
              }

              return exit
            }),
          ).pipe(Effect.orDie)

          if (result.kind === "abort") throw new Error("DeepSeek Harness consultation was aborted")
          if (result.kind === "timeout") {
            throw new Error(`DeepSeek Harness consultation timed out after ${timeoutMs}ms`)
          }

          const body = stripAnsi(stdout).trim()
          const failure = classifyDshFailure({
            exitCode: result.code,
            stdout,
            stderr,
          })
          if (failure) {
            throw new Error(
              [
                failure,
                "Ensure `dsh` is installed (`npm i -g @deepseek-ai/dsh`), on PATH,",
                "and authenticated with DEEPSEEK_API_KEY or ~/.dsh credentials.",
              ].join(" "),
            )
          }

          const header = [
            "<dsh_consult>",
            "profile: headless",
            `working_directory: ${workingDirectory}`,
            `exit_code: ${result.code}`,
            "</dsh_consult>",
          ].join("\n")

          yield* publishMetadata(true)

          return {
            title: "DeepSeek Harness consult",
            output: `${header}\n\n${body}`,
            metadata: {
              profile: "headless",
              working_directory: workingDirectory,
              prompt,
              exit_code: result.code,
              preview: body,
              transcript: [
                {
                  id: "assistant:final",
                  kind: "message",
                  title: "Assistant",
                  text: clip(body, MAX_PREVIEW),
                  status: "completed",
                },
              ],
            },
          }
        }),
    }
  }),
)

function resolveWorkingDirectory(input: string | undefined, projectDirectory: string): string {
  if (!input?.trim()) return projectDirectory
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(projectDirectory, input)
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "")
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`
}
