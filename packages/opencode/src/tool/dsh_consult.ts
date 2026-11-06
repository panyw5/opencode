import path from "path"
import { Effect, Fiber, Schema, Stream } from "effect"
import os from "node:os"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Tool from "./tool"
import DESCRIPTION from "./dsh_consult.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Config } from "@/config/config"
import { externalTurnFailure, resolveExternalCli } from "./external-cli"
import { parseDshCredentials } from "@opencode-ai/util/dsh-credentials"
import {
  DSH_DEFAULT_TIMEOUT_MS as DEFAULT_TIMEOUT_MS,
  DSH_MIN_TIMEOUT_MS as MIN_TIMEOUT_MS,
  DSH_MAX_TIMEOUT_MS as MAX_TIMEOUT_MS,
  parseDshConsultDefaults,
  assertDshPermissionSupport,
  type DshConsultDefaults,
} from "@opencode-ai/util/dsh-config"
import { applyDshJsonlLine, createDshJsonState, dshCapabilities, type DshEventItem } from "./dsh-protocol"
import { registerAdvisorIntervention } from "./advisor-intervention"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tool.dsh_consult" })

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
      "Absolute directory dsh should run in. Overrides the saved working directory; otherwise uses the current project. External directories require OpenCode approval.",
  }),
  timeout_ms: Schema.optional(Schema.Number).annotate({
    description: `Timeout in milliseconds. Overrides the user's default (otherwise ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
  }),
  profile: Schema.optional(Schema.String).annotate({
    description:
      'dsh profile to boot. Overrides the saved default (otherwise "headless"). Custom profiles must provide a compatible one-shot headless runner.',
  }),
  patch: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
    description:
      "Inline cordis.patch.yml YAML content (or a list of such). Replaces the saved patches; [] or an empty string skips them. Each entry is materialized as a temp file and applied via dsh --patch in order, without editing the shared DSH profile. Config replaces the whole plugin config. Patch errors fail the consult.",
  }),
  permission_mode: Schema.optional(Schema.String).annotate({
    description:
      "DSH permission preset, e.g. read-only, workspace-write, or danger-full-access. Overrides the saved default for this consult.",
  }),
  approval_policy: Schema.optional(Schema.Literals(["ask", "never"])).annotate({
    description:
      "DSH approval policy. never rejects actions that require approval; it does not grant unrestricted access. Overrides the saved default.",
  }),
  additional_writable_roots: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Additional absolute directories writable under workspace-write. Replaces the saved list; [] clears it for this consult. External directories require OpenCode approval.",
  }),
})

export type DshConsultParams = Schema.Schema.Type<typeof Parameters>

type DshPolicyOptions = {
  permissionMode?: string
  approvalPolicy?: "ask" | "never"
  additionalWritableRoots?: readonly string[]
}

export type DshExecBuildInput = DshPolicyOptions & {
  prompt: string
  profile?: string
  /** Resolved patch-file paths, each applied via `dsh --patch <file>` in order. */
  patch?: readonly string[]
  json?: boolean
  sessionId?: string
}

export type DshTranscriptItem = DshEventItem

export type DshTurn = {
  role: "user" | "assistant"
  text: string
}

export function dshTranscriptItem(item: DshTranscriptItem, turn: number): DshTranscriptItem {
  if (item.id === "assistant:live" || item.id === "assistant:final" || item.id.startsWith("intervention-assistant:")) {
    return { ...item, id: `assistant:turn:${turn}` }
  }
  if (/^(event|call|result):/.test(item.id)) return { ...item, id: "turn:" + turn + ":" + item.id }
  return item
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
 * Prefer native resume; older headless profiles replay the bounded transcript.
 */
export function buildDshFollowupArgs(
  input: DshPolicyOptions & {
    history: readonly DshTurn[]
    followup: string
    profile?: string
    patch?: readonly string[]
    json?: boolean
    sessionId?: string
  },
): string[] {
  if (input.sessionId) return buildDshArgs(input, input.followup)
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
function buildDshArgs(input: Omit<DshExecBuildInput, "prompt">, task: string): string[] {
  const args = ["--profile", resolveProfile(input.profile)]
  for (const file of input.patch ?? []) args.push("--patch", file)
  if (input.permissionMode) args.push("--permission-mode", input.permissionMode)
  if (input.approvalPolicy) args.push("--approval-policy", input.approvalPolicy)
  for (const root of input.additionalWritableRoots ?? []) args.push("--add-dir", root)
  if (input.json) args.push("--json")
  if (input.sessionId) args.push("--session-id", input.sessionId)
  if (
    input.json ||
    input.sessionId ||
    input.permissionMode ||
    input.approvalPolicy ||
    input.additionalWritableRoots?.length
  )
    args.push("--")
  args.push(task)
  return args
}

/** Resolve the profile name, defaulting to the headless one-shot bundle. */
export function resolveProfile(profile: string | undefined): string {
  const value = profile?.trim()
  if (value && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`dsh profile must be a name without whitespace or path separators: ${JSON.stringify(value)}`)
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

/** Resolve one consult once; follow-ups retain its configuration and write grants. */
export function resolveDshConsultOptions(params: Omit<DshConsultParams, "prompt">, defaults?: DshConsultDefaults) {
  const saved = defaults === undefined ? {} : parseDshConsultDefaults(defaults)
  const workingDirectory = params.working_directory ?? saved.working_directory
  if (workingDirectory !== undefined && (!path.isAbsolute(workingDirectory) || workingDirectory.includes("\0"))) {
    throw new Error("DSH working_directory must be an absolute directory path")
  }
  const additionalWritableRoots = [
    ...new Set(params.additional_writable_roots ?? saved.additional_writable_roots ?? []),
  ]
  if (additionalWritableRoots.some((root) => !path.isAbsolute(root) || root.includes("\0"))) {
    throw new Error("DSH additional_writable_roots must contain absolute directory paths")
  }
  const permissionMode = params.permission_mode ?? saved.permission_mode
  if (permissionMode !== undefined && (!permissionMode.trim() || permissionMode.includes("\0"))) {
    throw new Error("DSH permission_mode must name a permission preset")
  }
  return {
    profile: resolveProfile(params.profile ?? saved.profile),
    workingDirectory,
    timeoutMs: resolveTimeoutMs(params.timeout_ms ?? saved.timeout_ms),
    patchSources: normalizePatchSources(params.patch ?? saved.patch),
    permissionMode: permissionMode?.trim(),
    approvalPolicy: params.approval_policy ?? saved.approval_policy,
    additionalWritableRoots,
  }
}

export function assertDshPolicySupport(help: string, policy: DshPolicyOptions): void {
  assertDshPermissionSupport(help, {
    permission_mode: policy.permissionMode,
    approval_policy: policy.approvalPolicy,
    additional_writable_roots: policy.additionalWritableRoots?.slice(),
  })
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

  if (!stdout && /MISSING_CREDENTIAL|no API key/i.test(stderr)) {
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
    return detail ? `dsh returned empty stdout: ${clip(detail, 4000)}` : "dsh returned an empty response"
  }

  return undefined
}

export const DshConsultTool = Tool.define(
  "dsh_consult",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const configs = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: DshConsultParams, ctx: Tool.Context) => {
        let intervention: ReturnType<typeof registerAdvisorIntervention> | undefined
        return Effect.scoped(
          Effect.gen(function* () {
            const ins = yield* InstanceState.context
            const runtime = resolveExternalCli("dsh", (yield* configs.get()).external_agents?.dsh)
            const options = resolveDshConsultOptions(params, runtime.defaults)
            const { profile, timeoutMs, patchSources, permissionMode, approvalPolicy, additionalWritableRoots } =
              options
            const policy = { permissionMode, approvalPolicy, additionalWritableRoots }
            const workingDirectory = resolveWorkingDirectory(options.workingDirectory, ins.directory)
            log.info(
              "invocation resolved advisor=dsh profile=" +
                profile +
                " timeoutMs=" +
                timeoutMs +
                " permissionMode=" +
                (permissionMode ?? "inherit") +
                " approvalPolicy=" +
                (approvalPolicy ?? "inherit") +
                " extraRoots=" +
                additionalWritableRoots.length +
                " patches=" +
                patchSources.length,
            )

            yield* ctx.ask({
              permission: "dsh_consult",
              patterns: [workingDirectory],
              always: ["*"],
              metadata: {
                working_directory: workingDirectory,
                permission_mode: permissionMode,
                approval_policy: approvalPolicy,
                additional_writable_roots: additionalWritableRoots,
                profile,
                patch_count: patchSources.length,
                prompt_preview: params.prompt.slice(0, 200),
              },
            })

            yield* assertExternalDirectoryEffect(ctx, workingDirectory, { kind: "directory" })
            for (const root of additionalWritableRoots) {
              yield* assertExternalDirectoryEffect(ctx, root, { kind: "directory" })
            }

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

            const bin = runtime.binary
            const credentialsFile = path.join(runtime.home, ".credentials.yaml")
            const env: Record<string, string | undefined> = { ...runtime.env }
            log.info("runtime resolved advisor=dsh binary=" + bin + " home=" + runtime.home)
            if (yield* fs.exists(credentialsFile).pipe(Effect.orDie)) {
              log.info("credentials reading advisor=dsh")
              const document = yield* fs.readFileString(credentialsFile).pipe(Effect.orDie)
              const key = parseDshCredentials(document).get("DEEPSEEK_API_KEY")
              if (key) env.DEEPSEEK_API_KEY = key
              log.info("credentials resolved advisor=dsh storedKey=" + !!key)
            }
            // Supply the saved key explicitly: modern headless omits the GUI
            // credential store. Never put secrets in argv or diagnostic logs.
            const help = yield* spawner
              .string(
                ChildProcess.make(
                  bin,
                  ["--profile", profile, ...patchFiles.flatMap((file) => ["--patch", file]), "--help"],
                  {
                    cwd: workingDirectory,
                    extendEnv: true,
                    env,
                    stdin: "ignore",
                  },
                ),
                { includeStderr: true },
              )
              .pipe(
                Effect.timeout("5 seconds"),
                Effect.orElseSucceed(() => ""),
              )
            const capabilities = dshCapabilities(help)
            assertDshPolicySupport(help, policy)
            const json = capabilities.json && capabilities.resume
            let sessionId: string | undefined
            log.info("capabilities advisor=dsh json=" + capabilities.json + " resume=" + capabilities.resume)

            const prompt = params.prompt.trim()
            if (!prompt) throw new Error("prompt must be a non-empty string")

            const history: DshTurn[] = [{ role: "user", text: prompt }]
            const transcript: DshTranscriptItem[] = [
              {
                id: "user:initial",
                kind: "user",
                title: "User",
                text: prompt,
                status: "completed",
              },
            ]

            let body = ""
            let lastExitCode: number | null = null
            let lastMetaAt = 0
            let streamPreview = ""
            let transcriptTurn = 0

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
                    permission_mode: permissionMode,
                    approval_policy: approvalPolicy,
                    additional_writable_roots: additionalWritableRoots,
                    session_id: sessionId,
                    json,
                    patch_count: patchFiles.length,
                    prompt,
                    preview: preview ? clip(preview, MAX_PREVIEW) : undefined,
                    transcript: transcript.slice(),
                    intervention: intervention?.snapshot(),
                  },
                })
              })

            const upsertTranscript = (item: DshTranscriptItem) => {
              item = dshTranscriptItem(item, transcriptTurn)
              const capture = ctx.extra?.externalTranscript as ((item: DshTranscriptItem) => void) | undefined
              capture?.(item)
              item = { ...item, text: item.text === undefined ? undefined : clip(item.text, MAX_PREVIEW) }
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
                  const state = createDshJsonState()
                  state.onItem = (item) => {
                    upsertTranscript(item)
                    if (item.kind === "message") streamPreview = item.text ?? ""
                  }
                  log.info("process starting advisor=dsh turn=" + transcriptTurn + " nativeResume=" + !!sessionId)
                  const handle = yield* spawner.spawn(
                    ChildProcess.make(bin, args, {
                      cwd: workingDirectory,
                      extendEnv: true,
                      env,
                      stdin: "ignore",
                    }),
                  )

                  let stdout = ""
                  let stderr = ""
                  let lineBuffer = ""
                  streamPreview = ""

                  const stdoutFiber = yield* Effect.forkScoped(
                    Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                      Effect.gen(function* () {
                        stdout += chunk
                        if (json) {
                          lineBuffer += chunk
                          const lines = lineBuffer.split(/\r?\n/)
                          lineBuffer = lines.pop() ?? ""
                          for (const line of lines) applyDshJsonlLine(state, line)
                        } else {
                          streamPreview = stripAnsi(stdout).trim()
                          upsertTranscript({
                            id: "assistant:live",
                            kind: "message",
                            title: "Assistant",
                            text: streamPreview,
                            status: "running",
                          })
                        }
                        yield* publishMetadata()
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

                  yield* Fiber.join(stdoutFiber).pipe(
                    Effect.timeout("10 seconds"),
                    Effect.orElseSucceed(() => undefined),
                  )
                  yield* Fiber.join(stderrFiber).pipe(
                    Effect.timeout("10 seconds"),
                    Effect.orElseSucceed(() => undefined),
                  )
                  if (json && lineBuffer.trim()) applyDshJsonlLine(state, lineBuffer)
                  if (state.sessionId) sessionId = state.sessionId
                  const answer = json ? state.answer : stripAnsi(stdout).trim()
                  const failure = json
                    ? externalTurnFailure({
                        advisor: "DSH",
                        exitCode: exit.code,
                        completed: state.completed && state.final,
                        error:
                          state.error || (!state.sessionId ? "DSH stream omitted its session identity" : undefined),
                        answer,
                        stderr,
                      })
                    : classifyDshFailure({ exitCode: exit.code, stdout, stderr })
                  log.info(
                    "process validated advisor=dsh exit=" +
                      exit.code +
                      " success=" +
                      !failure +
                      " session=" +
                      (sessionId ?? "legacy"),
                  )
                  yield* publishMetadata(true)
                  return { exit, stdout, stderr, answer, failure }
                }),
              ).pipe(Effect.orDie)

            yield* publishMetadata(true)
            log.info("starting dsh consult", { bin, cwd: workingDirectory, timeoutMs })

            let result = yield* runProcess(buildDshExecArgs({ prompt, profile, patch: patchFiles, json, ...policy }))
            if (result.exit.kind === "abort") throw new Error("DeepSeek Harness consultation was aborted")
            if (result.exit.kind === "timeout") {
              throw new Error(`DeepSeek Harness consultation timed out after ${timeoutMs}ms`)
            }

            lastExitCode = result.exit.code
            body = result.answer
            const failure = result.failure
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
              text: body,
              status: "completed",
            })
            // Drop the live streaming row once the final answer is recorded.
            const liveIndex = transcript.findIndex((item) => item.id === "assistant:live")
            if (liveIndex >= 0) transcript.splice(liveIndex, 1)
            streamPreview = ""
            yield* publishMetadata(true)

            const started = intervention?.isActive() ?? false
            log.info("dsh consult turn completed", {
              sessionID: ctx.sessionID,
              callID: ctx.callID,
              exitCode: result.exit.code,
              interventionActive: started,
            })
            const activeIntervention = intervention
            if (started && activeIntervention) {
              while (activeIntervention.isActive()) {
                const command = yield* Effect.promise(() => activeIntervention.wait(ctx.abort))
                if (command.type === "abort") throw new Error("DeepSeek Harness consultation was aborted")
                if (command.type !== "message") break

                const followup = command.message.trim()
                if (!followup) continue
                transcriptTurn++

                upsertTranscript({
                  id: `intervention-user:${Date.now()}`,
                  kind: "user",
                  title: "User",
                  text: followup,
                  status: "completed",
                })
                history.push({ role: "user", text: followup })
                yield* publishMetadata(true)

                activeIntervention.setBusy(true)
                try {
                  result = yield* runProcess(
                    buildDshFollowupArgs({
                      history: history.slice(0, -1),
                      followup,
                      profile,
                      patch: patchFiles,
                      json,
                      sessionId,
                      ...policy,
                    }),
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
                const nextBody = result.answer
                const nextFailure = result.failure
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
                  text: body,
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
                timeout_ms: timeoutMs,
                permission_mode: permissionMode,
                approval_policy: approvalPolicy,
                additional_writable_roots: additionalWritableRoots,
                session_id: sessionId,
                json,
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
