import path from "path"
import { Effect, Schema, Stream } from "effect"
import os from "node:os"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Tool from "./tool"
import DESCRIPTION from "./dsh_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { which } from "@/util/which"
import { holdForIntervention, registerAdvisorIntervention } from "./advisor-intervention"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.dsh_consult" })

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TIMEOUT_MS = 30 * 60 * 1000
const MIN_TIMEOUT_MS = 30 * 1000
const METADATA_THROTTLE_MS = 200
const MAX_PREVIEW = 8_000
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_HISTORY_CHARS = 24_000

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
  profile: Schema.optional(Schema.String).annotate({
    description:
      'dsh profile to boot (default "headless"). A profile is a named plugin composition; a custom profile changes which model adapters, tools, presets, and bundles mount for this consult. Must be a single token (no whitespace).',
  }),
  patch: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
    description:
      "Inline cordis.patch.yml YAML content (or a list of such). Each entry is written to a temp file and applied via `dsh --patch <file>` after the profile layer, so this consult can dynamically override model, tools, persona, presets, or other config rows at boot without touching ~/.dsh. Entries layer in the order given. A patch that fails to apply fails the consult with the dsh error.",
  }),
})

export type DshConsultParams = Schema.Schema.Type<typeof Parameters>

export type DshExecBuildInput = {
  prompt: string
  profile?: string
  /** Resolved patch-file paths, each applied via `dsh --patch <file>` in order. */
  patch?: readonly string[]
}

export type DshTranscriptItem = {
  id: string
  kind: "message" | "user" | "status" | "error"
  title?: string
  text?: string
  status?: string
}

export type DshTurn = {
  role: "user" | "assistant"
  text: string
}

/** Frame a one-shot headless task for dsh (shared with tests). */
export function frameDshPrompt(prompt: string): string {
  return [
    "You are an external advisor consulted by OpenCode.",
    "Prefer analysis, risks, alternatives, and concrete recommendations.",
    "Avoid unnecessary file modifications unless the request explicitly requires implementation.",
    "Be concise and structured.",
    "",
    "Consultation request:",
    prompt,
  ].join("\n")
}

/** Build argv for a one-shot `dsh --profile headless` consult. */
export function buildDshExecArgs(input: DshExecBuildInput): string[] {
  return buildDshArgs(input, frameDshPrompt(input.prompt))
}

/**
 * Headless dsh has no session resume. Continue intervention by replaying prior
 * turns into a fresh one-shot prompt (same UX surface as codex/claude/grok).
 */
export function buildDshFollowupArgs(input: {
  history: readonly DshTurn[]
  followup: string
  profile?: string
  patch?: readonly string[]
}): string[] {
  const historyBlock = formatDshHistory(input.history)
  const framed = [
    "You are an external advisor consulted by OpenCode.",
    "This is a follow-up intervention in an ongoing consultation.",
    "Use the prior consultation transcript as context, then answer the new user message.",
    "Prefer analysis, risks, alternatives, and concrete recommendations.",
    "Avoid unnecessary file modifications unless the request explicitly requires implementation.",
    "Be concise and structured.",
    "",
    "Prior consultation transcript:",
    historyBlock || "(empty)",
    "",
    "New user message:",
    input.followup,
  ].join("\n")
  return buildDshArgs(input, framed)
}

/** Launcher flags first, then the task as the inner argument. */
function buildDshArgs(input: { profile?: string; patch?: readonly string[] }, task: string): string[] {
  const args = ["--profile", resolveProfile(input.profile)]
  for (const file of input.patch ?? []) args.push("--patch", file)
  args.push(task)
  return args
}

/** Resolve the profile name, defaulting to the headless one-shot bundle. */
export function resolveProfile(profile: string | undefined): string {
  const value = profile?.trim()
  if (value && /\s/.test(value)) {
    throw new Error(`dsh profile must not contain whitespace: ${JSON.stringify(value)}`)
  }
  return value || "headless"
}

/** Normalize the `patch` parameter (single string or list) to non-empty entries. */
export function normalizePatchSources(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []
  const entries = typeof value === "string" ? [value] : value
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

export function formatDshHistory(history: readonly DshTurn[]): string {
  if (history.length === 0) return ""
  const lines = history.map((turn) => {
    const label = turn.role === "user" ? "User" : "Advisor"
    return `${label}:\n${turn.text.trim()}`
  })
  let text = lines.join("\n\n")
  if (text.length <= MAX_HISTORY_CHARS) return text
  text = text.slice(text.length - MAX_HISTORY_CHARS)
  const cut = text.indexOf("\n\n")
  if (cut > 0 && cut < 400) text = text.slice(cut + 2)
  return `...(earlier turns truncated)...\n\n${text}`
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
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: DshConsultParams, ctx: Tool.Context) => {
        let intervention: ReturnType<typeof registerAdvisorIntervention> | undefined
        return Effect.scoped(
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

            const profile = resolveProfile(params.profile)
            const patchSources = normalizePatchSources(params.patch)
            const patchFiles: string[] = []
            if (patchSources.length > 0) {
              const tmpDir = yield* fs
                .makeTempDirectoryScoped({ directory: os.tmpdir(), prefix: "opencode-dsh-patch-" })
                .pipe(Effect.orDie)
              for (const [index, content] of patchSources.entries()) {
                const file = path.join(tmpDir, `patch-${index + 1}.yml`)
                yield* fs.writeFileString(file, content.endsWith("\n") ? content : `${content}\n`).pipe(Effect.orDie)
                patchFiles.push(file)
              }
            }

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
            const history: DshTurn[] = [{ role: "user", text: prompt }]
            const transcript: DshTranscriptItem[] = [
              {
                id: "user:initial",
                kind: "user",
                title: "User",
                text: clip(prompt, MAX_PREVIEW),
                status: "completed",
              },
            ]

            let body = ""
            let lastExitCode: number | null = null
            let lastMetaAt = 0
            let streamPreview = ""

            let publishMetadata: (force?: boolean) => Effect.Effect<void>
            intervention = ctx.callID
              ? registerAdvisorIntervention({
                  sessionID: ctx.sessionID,
                  callID: ctx.callID,
                  advisor: "dsh",
                  onChange: () => void Effect.runPromise(publishMetadata(true)),
                })
              : undefined

            publishMetadata = (force = false) =>
              Effect.gen(function* () {
                const now = Date.now()
                if (!force && now - lastMetaAt < METADATA_THROTTLE_MS) return
                lastMetaAt = now
                const preview = (streamPreview || body).trim()
                yield* ctx.metadata({
                  title: preview
                    ? `DeepSeek: ${clip(preview, 80).replace(/\s+/g, " ")}`
                    : "Consulting DeepSeek Harness",
                  metadata: {
                    bin,
                    working_directory: workingDirectory,
                    timeout_ms: timeoutMs,
                    profile,
                    patch_count: patchFiles.length,
                    prompt,
                    preview: preview ? clip(preview, MAX_PREVIEW) : undefined,
                    transcript: transcript.slice(),
                    intervention: intervention?.snapshot(),
                  },
                })
              })

            const upsertTranscript = (item: DshTranscriptItem) => {
              const index = transcript.findIndex((entry) => entry.id === item.id)
              if (index >= 0) transcript[index] = { ...transcript[index], ...item }
              else {
                transcript.push(item)
                if (transcript.length > MAX_TRANSCRIPT_ITEMS) {
                  transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ITEMS)
                }
              }
            }

            const runProcess = (args: string[]) =>
              Effect.scoped(
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
                  streamPreview = ""

                  yield* Effect.forkScoped(
                    Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                      Effect.gen(function* () {
                        stdout += chunk
                        streamPreview = stripAnsi(stdout).trim()
                        upsertTranscript({
                          id: "assistant:live",
                          kind: "message",
                          title: "Assistant",
                          text: clip(streamPreview, MAX_PREVIEW),
                          status: "running",
                        })
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

                  return { exit, stdout, stderr }
                }),
              ).pipe(Effect.orDie)

            yield* publishMetadata(true)
            log.info("starting dsh consult", { bin, cwd: workingDirectory, timeoutMs })

            let result = yield* runProcess(buildDshExecArgs({ prompt, profile, patch: patchFiles }))
            if (result.exit.kind === "abort") throw new Error("DeepSeek Harness consultation was aborted")
            if (result.exit.kind === "timeout") {
              throw new Error(`DeepSeek Harness consultation timed out after ${timeoutMs}ms`)
            }

            lastExitCode = result.exit.code
            body = stripAnsi(result.stdout).trim()
            const failure = classifyDshFailure({
              exitCode: result.exit.code,
              stdout: result.stdout,
              stderr: result.stderr,
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

            history.push({ role: "assistant", text: body })
            upsertTranscript({
              id: "assistant:final",
              kind: "message",
              title: "Assistant",
              text: clip(body, MAX_PREVIEW),
              status: "completed",
            })
            // Drop the live streaming row once the final answer is recorded.
            const liveIndex = transcript.findIndex((item) => item.id === "assistant:live")
            if (liveIndex >= 0) transcript.splice(liveIndex, 1)
            streamPreview = ""
            yield* publishMetadata(true)

            // Hold the tool open so the desktop dialog can still start intervention
            // after the first answer lands (entry would otherwise be closed already).
            const started = yield* Effect.promise(() => holdForIntervention(intervention, ctx.abort))
            const activeIntervention = intervention
            if (started && activeIntervention) {
              while (activeIntervention.isActive()) {
                const command = yield* Effect.promise(() => activeIntervention.wait(ctx.abort))
                if (command.type === "abort") throw new Error("DeepSeek Harness consultation was aborted")
                if (command.type !== "message") break

                const followup = command.message.trim()
                if (!followup) continue

                upsertTranscript({
                  id: `intervention-user:${Date.now()}`,
                  kind: "user",
                  title: "User",
                  text: clip(followup, MAX_PREVIEW),
                  status: "completed",
                })
                history.push({ role: "user", text: followup })
                yield* publishMetadata(true)

                activeIntervention.setBusy(true)
                try {
                  result = yield* runProcess(
                    buildDshFollowupArgs({ history: history.slice(0, -1), followup, profile, patch: patchFiles }),
                  )
                } finally {
                  activeIntervention.setBusy(false)
                  yield* publishMetadata(true)
                }

                if (result.exit.kind === "abort") throw new Error("DeepSeek Harness consultation was aborted")
                if (result.exit.kind === "timeout") {
                  throw new Error(`DeepSeek Harness consultation timed out after ${timeoutMs}ms`)
                }

                lastExitCode = result.exit.code
                const nextBody = stripAnsi(result.stdout).trim()
                const nextFailure = classifyDshFailure({
                  exitCode: result.exit.code,
                  stdout: result.stdout,
                  stderr: result.stderr,
                })
                if (nextFailure) {
                  upsertTranscript({
                    id: `intervention-error:${Date.now()}`,
                    kind: "error",
                    title: "Error",
                    text: clip(nextFailure, MAX_PREVIEW),
                    status: "error",
                  })
                  yield* publishMetadata(true)
                  continue
                }
                if (!nextBody) {
                  upsertTranscript({
                    id: `intervention-error:${Date.now()}`,
                    kind: "error",
                    title: "Error",
                    text: "DeepSeek Harness returned an empty response",
                    status: "error",
                  })
                  yield* publishMetadata(true)
                  continue
                }

                body = nextBody
                history.push({ role: "assistant", text: body })
                upsertTranscript({
                  id: `intervention-assistant:${Date.now()}`,
                  kind: "message",
                  title: "Assistant",
                  text: clip(body, MAX_PREVIEW),
                  status: "completed",
                })
                const live = transcript.findIndex((item) => item.id === "assistant:live")
                if (live >= 0) transcript.splice(live, 1)
                streamPreview = ""
                yield* publishMetadata(true)
              }
            }

            intervention?.close()

            const header = [
              "<dsh_consult>",
              `profile: ${profile}`,
              `patches: ${patchFiles.length}`,
              `working_directory: ${workingDirectory}`,
              `exit_code: ${lastExitCode}`,
              `turns: ${history.filter((turn) => turn.role === "user").length}`,
              "</dsh_consult>",
            ].join("\n")

            return {
              title: "DeepSeek Harness consult",
              output: `${header}\n\n${body}`,
              metadata: {
                profile,
                patch_count: patchFiles.length,
                working_directory: workingDirectory,
                prompt,
                exit_code: lastExitCode,
                preview: body,
                transcript: transcript.slice(),
              },
            }
          }).pipe(Effect.ensuring(Effect.sync(() => intervention?.close()))),
        )
      },
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
