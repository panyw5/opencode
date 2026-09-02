import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import path from "path"
import { createHash } from "node:crypto"
import { Cause, Duration, Effect, Exit, Option } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import { MCP } from "@/mcp"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { layout, mathRoot, taskPath } from "./layout"
import { killProcessGroup, pidAlive, selfArgv, spawnDetached } from "./spawn"
import { clearStop, patchWorker, readSwarm, setVerifierModel, stopPath, upsertWorker, type SwarmWorker } from "./swarm"
import { FactGraph } from "./fact-graph"
import { GlobalMemory } from "./global-memory"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import * as Log from "@opencode-ai/core/util/log"
import { parse as parseJsonc } from "jsonc-parser"

const log = Log.create({ service: "math.worker" })
export const MAX_MATH_WORKER_NO_PROGRESS_ROUNDS = 8
export const MAX_MATH_WORKER_VERIFIER_ERROR_STREAK = 3

const activeServerUrl = Effect.fnUntraced(function* () {
  if (process.env.OPENCODE_MATH_PARENT_SERVER_URL) return process.env.OPENCODE_MATH_PARENT_SERVER_URL
  return yield* Effect.tryPromise({
    try: async () => (await import("@/server/server")).url?.origin,
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))
})

const notifyParent = Effect.fn("MathWorker.notifyParent")(function* (input: {
  serverUrl?: string
  parentSessionID?: string
  workerSessionID: string
  directory: string
  eventID: string
  kind: "progress" | "completed" | "blocked" | "failed"
  round: number
  factID?: string
  reason?: string
  summary: string
  generation: number
  taskFingerprint: string
}) {
  if (!input.serverUrl || !input.parentSessionID) return false
  const url = new URL(
    `/session/${encodeURIComponent(input.parentSessionID)}/math-workers/${encodeURIComponent(input.workerSessionID)}/event`,
    input.serverUrl,
  )
  url.searchParams.set("directory", input.directory)
  const password = process.env.OPENCODE_SERVER_PASSWORD
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-opencode-directory": input.directory,
  }
  if (password) {
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const delivered = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(5_000),
          body: JSON.stringify({
            eventID: input.eventID,
            kind: input.kind,
            round: input.round,
            factID: input.factID,
            reason: input.reason,
            summary: input.summary,
            generation: input.generation,
            taskFingerprint: input.taskFingerprint,
          }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return true
      },
      catch: (error) => error,
    }).pipe(Effect.orElseSucceed(() => false))
    if (delivered) return true
    if (attempt < 3) yield* Effect.sleep(Duration.millis(250 * attempt))
  }
  log.warn("math worker parent notification failed", {
    parentSessionID: input.parentSessionID,
    workerSessionID: input.workerSessionID,
    eventID: input.eventID,
    kind: input.kind,
  })
  return false
})

export type StartInput = {
  parentSessionID: SessionID
  title: string
  task: string
  project?: string
  intervalMs?: number
  model?: string
  variant?: string
  verifierModel?: string
  /** Injected in tests. Production uses spawnDetached(selfArgv(...)). */
  spawn?: (input: { argv: string[]; cwd: string; logFile: string; env?: NodeJS.ProcessEnv }) => { pid: number }
}

export type StartResult = {
  sessionID: string
  pid: number
  state: "running"
  projectDir: string
  logFile: string
}

export type StatusResult = {
  sessionID: string
  parentSessionID?: string
  alive: boolean
  state: SwarmWorker["state"] | "missing"
  pid?: number
  round?: number
  last_fact_id?: string
  last_rc?: number | null
  lastHeartbeatAt?: number
  logFile?: string
  attachable?: boolean
  restartable?: boolean
  stopRequested?: boolean
  transcriptUpdatedAt?: number
  project?: string
  model?: string
  variant?: string
  startedAt?: number
  cost?: number
  tokens?: number
  taskUpdatedAt?: number
  taskPreview?: string
  factCount?: number
  verificationCorrect?: number
  verificationWrong?: number
  verificationError?: number
  latestVerification?: string
  verifierModel?: string
  noProgressRounds?: number
  verificationErrorStreak?: number
  blockedReason?: string
  blockedAt?: number
  generation?: number
  blockedTaskFingerprint?: string
  lastOutcome?: SwarmWorker["lastOutcome"]
  lastSummary?: string
}

export type MathWorkerTaskInfo = {
  sessionID: string
  project: string
  task: string
  updatedAt: number
}

export type EnsureResult = StartResult & {
  restarted: boolean
  previousPid?: number
  round: number
}

function resolveProjectDir(workspace: string, project: string | undefined, parentSessionID: string): string {
  return mathRoot(workspace, project || parentSessionID)
}

function acquireEnsureLock(projectDir: string, sessionID: string): () => void {
  const lockDir = path.join(projectDir, "locks")
  const lockFile = path.join(lockDir, `ensure-${sessionID}.lock`)
  mkdirSync(lockDir, { recursive: true })
  const open = () => {
    try {
      return openSync(lockFile, "wx")
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined
      if (code !== "EEXIST") throw error
      let owner = 0
      try {
        owner = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10)
      } catch {
        owner = 0
      }
      if (owner > 0 && pidAlive(owner)) throw new Error(`math worker ensure already in progress: ${sessionID}`)
      try {
        unlinkSync(lockFile)
      } catch {
        throw new Error(`math worker ensure lock is busy: ${sessionID}`)
      }
      return openSync(lockFile, "wx")
    }
  }
  const fd = open()
  writeFileSync(fd, `${process.pid}\n`, "utf8")
  return () => {
    try {
      closeSync(fd)
    } finally {
      try {
        unlinkSync(lockFile)
      } catch {
        // A replacement owner must never have its lock removed by this process.
      }
    }
  }
}

export function workerMcpConfig(input: {
  projectDir: string
  workspace: string
  sessionID: string
  baseContent?: string
  verifierModel?: string
}) {
  const command = selfArgv([
    "math",
    "mcp",
    "--role",
    "worker",
    "--project-dir",
    input.projectDir,
    "--author",
    input.sessionID,
    "--problem-id",
    path.basename(input.projectDir) || "default",
  ])
  const parsed = input.baseContent ? parseJsonc(input.baseContent) : undefined
  const base = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  const existingMcp = base.mcp && typeof base.mcp === "object" && !Array.isArray(base.mcp) ? base.mcp : {}
  const existingAgent =
    base.agent && typeof base.agent === "object" && !Array.isArray(base.agent)
      ? (base.agent as Record<string, unknown>)
      : {}
  const workerAgent =
    existingAgent["math-worker"] &&
    typeof existingAgent["math-worker"] === "object" &&
    !Array.isArray(existingAgent["math-worker"])
      ? (existingAgent["math-worker"] as Record<string, unknown>)
      : {}
  const workerPermission =
    workerAgent.permission && typeof workerAgent.permission === "object" && !Array.isArray(workerAgent.permission)
      ? workerAgent.permission
      : {}
  return JSON.stringify({
    ...base,
    agent: {
      ...existingAgent,
      "math-worker": {
        ...workerAgent,
        permission: {
          ...workerPermission,
          external_directory: "deny",
        },
      },
    },
    mcp: {
      ...existingMcp,
      "math-truth": {
        type: "local",
        command,
        environment: {
          OPENCODE_MATH_WORKSPACE: input.workspace,
          OPENCODE_MATH_PROJECT_DIR: input.projectDir,
          OPENCODE_MATH_ROLE: "worker",
          OPENCODE_MATH_AUTHOR: input.sessionID,
          OPENCODE_MATH_PROBLEM_ID: path.basename(input.projectDir) || "default",
          ...((input.verifierModel ?? process.env.OPENCODE_MATH_VERIFY_MODEL)
            ? { OPENCODE_MATH_VERIFY_MODEL: (input.verifierModel ?? process.env.OPENCODE_MATH_VERIFY_MODEL)! }
            : {}),
        },
        timeout: 3_600_000,
      },
    },
  })
}

export const startMathWorker = Effect.fn("MathWorker.start")(function* (input: StartInput) {
  const sessions = yield* Session.Service
  const parentContext = yield* InstanceState.context
  const parent = yield* sessions.get(input.parentSessionID).pipe(Effect.orDie)
  const projectDir = resolveProjectDir(parent.directory, input.project, input.parentSessionID)
  const session = yield* sessions
    .create({
      parentID: input.parentSessionID,
      title: input.title,
      agent: "math-worker",
    })
    .pipe(Effect.provideService(InstanceRef, { ...parentContext, directory: projectDir }))
  const verifierModel = input.verifierModel ?? readSwarm(projectDir).verifierModel
  const parentServerUrl = yield* activeServerUrl()
  if (input.verifierModel) setVerifierModel(projectDir, input.verifierModel)
  mkdirSync(layout(projectDir).tasks, { recursive: true })
  mkdirSync(layout(projectDir).logs, { recursive: true })
  log.info("math worker problem workspace resolved", {
    sessionID: session.id,
    parent: input.parentSessionID,
    problemID: path.basename(projectDir),
    projectDir,
  })
  if (!existsSync(layout(projectDir).problem)) {
    log.warn("math worker PROBLEM.md is missing; worker rounds will start without the problem statement", {
      sessionID: session.id,
      problemID: path.basename(projectDir),
      problemFile: layout(projectDir).problem,
    })
  }

  const taskFile = taskPath(projectDir, session.id)
  writeFileSync(taskFile, input.task.trim() + "\n", "utf8")
  const taskFingerprint = mathWorkerTaskFingerprint(input.task)
  const generation = 1
  const logFile = path.join(layout(projectDir).logs, `worker-${session.id}.log`)

  const argv = selfArgv([
    "math",
    "worker",
    "--session",
    session.id,
    "--project-dir",
    projectDir,
    "--dir",
    projectDir,
    "--generation",
    String(generation),
    ...(input.intervalMs ? ["--interval", String(input.intervalMs)] : []),
    ...((input.model ?? process.env.OPENCODE_MATH_WORKER_MODEL)
      ? ["--model", (input.model ?? process.env.OPENCODE_MATH_WORKER_MODEL)!]
      : []),
    ...(input.variant ? ["--variant", input.variant] : []),
  ])
  const spawn = input.spawn ?? spawnDetached
  const { pid } = spawn({
    argv,
    cwd: projectDir,
    logFile,
    env: {
      OPENCODE_CONFIG_CONTENT: workerMcpConfig({
        projectDir,
        workspace: projectDir,
        sessionID: session.id,
        baseContent: process.env.OPENCODE_CONFIG_CONTENT,
        verifierModel,
      }),
      OPENCODE_MATH_WORKSPACE: projectDir,
      OPENCODE_MATH_PROJECT_DIR: projectDir,
      OPENCODE_MATH_ROLE: "worker",
      ...(parentServerUrl ? { OPENCODE_MATH_PARENT_SERVER_URL: parentServerUrl } : {}),
    },
  })
  log.info("math worker spawned", { sessionID: session.id, pid, cwd: projectDir, argv: argv.join(" ") })

  upsertWorker(projectDir, {
    sessionID: session.id,
    parentSessionID: input.parentSessionID,
    pid,
    state: "running",
    startedAt: Date.now(),
    logFile,
    taskFile,
    round: 0,
    model: input.model ?? process.env.OPENCODE_MATH_WORKER_MODEL,
    variant: input.variant,
    generation,
    taskFingerprint,
  })

  return {
    sessionID: session.id,
    pid,
    state: "running" as const,
    projectDir,
    logFile,
  } satisfies StartResult
})

const ensureMathWorkerUnlocked = Effect.fn("MathWorker.ensureUnlocked")(function* (input: {
  sessionID: SessionID
  projectDir: string
  intervalMs?: number
  model?: string
  variant?: string
  verifierModel?: string
  reEnable?: boolean
  spawn?: StartInput["spawn"]
}) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(input.sessionID)
  if (session.agent !== "math-worker") throw new Error(`session is not a math-worker: ${input.sessionID}`)

  const existing = readSwarm(input.projectDir).workers[input.sessionID]
  if (input.verifierModel) {
    log.info("math verifier model updated", { projectDir: input.projectDir, model: input.verifierModel })
    setVerifierModel(input.projectDir, input.verifierModel)
  }
  const verifierModel = input.verifierModel ?? readSwarm(input.projectDir).verifierModel
  const parentServerUrl = yield* activeServerUrl()
  const taskFile = existing?.taskFile ?? taskPath(input.projectDir, input.sessionID)
  const logFile = existing?.logFile ?? path.join(layout(input.projectDir).logs, `worker-${input.sessionID}.log`)
  const stop = stopPath(input.projectDir, input.sessionID)
  if (!existsSync(taskFile)) throw new Error(`math worker TASK is missing: ${taskFile}`)
  const currentTaskFingerprint = mathWorkerTaskFingerprint(readFileSync(taskFile, "utf8"))
  const blockedSameTask = existing?.state === "blocked" && existing.blockedTaskFingerprint === currentTaskFingerprint
  const infraRetry = blockedSameTask && isInfraBlockedReason(existing?.blockedReason)
  if (blockedSameTask && !infraRetry) {
    throw new Error(`math worker TASK must change before retrying a blocked lane: ${input.sessionID}`)
  }
  // Infra failures (verifier/model/process) may retry the unchanged TASK, but only a bounded
  // number of times before the orchestrator must change the TASK or the environment.
  const infraRetryStreak = infraRetry ? (existing?.verificationErrorStreak ?? 0) + 1 : 0
  if (infraRetry && infraRetryStreak > MAX_MATH_WORKER_VERIFIER_ERROR_STREAK) {
    throw new Error(
      `math worker infra failures persisted across ${infraRetryStreak} retries; revise the TASK or environment: ${input.sessionID}`,
    )
  }
  if (existsSync(stop)) {
    if (!input.reEnable) throw new Error(`math worker has a stop request; refusing restart: ${input.sessionID}`)
    if (existing && pidAlive(existing.pid)) {
      throw new Error(`math worker is still stopping; wait for process exit before re-enabling: ${input.sessionID}`)
    }
    log.info("math worker re-enable requested", { sessionID: input.sessionID, projectDir: input.projectDir })
    clearStop(input.projectDir, input.sessionID)
  }
  if (existing && pidAlive(existing.pid)) {
    return {
      sessionID: input.sessionID,
      pid: existing.pid,
      state: "running" as const,
      projectDir: input.projectDir,
      logFile,
      restarted: false,
      previousPid: existing.pid,
      round: existing.round ?? 0,
    } satisfies EnsureResult
  }

  mkdirSync(layout(input.projectDir).logs, { recursive: true })
  const generation = (existing?.generation ?? 0) + 1
  const argv = selfArgv([
    "math",
    "worker",
    "--session",
    input.sessionID,
    "--project-dir",
    input.projectDir,
    "--dir",
    input.projectDir,
    "--generation",
    String(generation),
    ...(input.intervalMs ? ["--interval", String(input.intervalMs)] : []),
    ...((input.model ?? existing?.model) ? ["--model", (input.model ?? existing?.model)!] : []),
    ...((input.variant ?? existing?.variant) ? ["--variant", (input.variant ?? existing?.variant)!] : []),
  ])
  const spawn = input.spawn ?? spawnDetached
  log.info("math worker restart confined to problem workspace", {
    sessionID: input.sessionID,
    problemID: path.basename(input.projectDir),
    projectDir: input.projectDir,
  })
  const { pid } = spawn({
    argv,
    cwd: input.projectDir,
    logFile,
    env: {
      OPENCODE_CONFIG_CONTENT: workerMcpConfig({
        projectDir: input.projectDir,
        workspace: input.projectDir,
        sessionID: input.sessionID,
        baseContent: process.env.OPENCODE_CONFIG_CONTENT,
        verifierModel,
      }),
      OPENCODE_MATH_WORKSPACE: input.projectDir,
      OPENCODE_MATH_PROJECT_DIR: input.projectDir,
      OPENCODE_MATH_ROLE: "worker",
      ...(parentServerUrl ? { OPENCODE_MATH_PARENT_SERVER_URL: parentServerUrl } : {}),
    },
  })
  const round = existing?.round ?? 0
  upsertWorker(input.projectDir, {
    sessionID: input.sessionID,
    parentSessionID: session.parentID ?? existing?.parentSessionID,
    pid,
    state: "running",
    startedAt: Date.now(),
    logFile,
    taskFile,
    round,
    lastFactId: existing?.lastFactId,
    lastRc: existing?.lastRc,
    lastHeartbeatAt: existing?.lastHeartbeatAt,
    model: input.model ?? existing?.model,
    variant: input.variant ?? existing?.variant,
    noProgressRounds: 0,
    verificationErrorStreak: infraRetryStreak,
    generation,
    taskFingerprint: currentTaskFingerprint,
    blockedTaskFingerprint: undefined,
    blockedReason: undefined,
    blockedAt: undefined,
    lastOutcome: undefined,
    lastSummary: undefined,
  })
  log.info("math worker ensured", { sessionID: input.sessionID, previousPid: existing?.pid, pid, round })
  return {
    sessionID: input.sessionID,
    pid,
    state: "running" as const,
    projectDir: input.projectDir,
    logFile,
    restarted: true,
    previousPid: existing?.pid,
    round,
  } satisfies EnsureResult
})

export const ensureMathWorker = Effect.fn("MathWorker.ensure")(function* (input: {
  sessionID: SessionID
  projectDir: string
  intervalMs?: number
  model?: string
  variant?: string
  verifierModel?: string
  reEnable?: boolean
  spawn?: StartInput["spawn"]
}) {
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => acquireEnsureLock(input.projectDir, input.sessionID)),
    () => ensureMathWorkerUnlocked(input),
    (release) => Effect.sync(release),
  )
})

export function statusMathWorker(input: {
  projectDir: string
  sessionID?: string
  parentSessionID?: string
}): StatusResult[] {
  const swarm = readSwarm(input.projectDir)
  const workers = Object.values(swarm.workers).filter((w) => {
    if (input.sessionID) return w.sessionID === input.sessionID
    if (input.parentSessionID) return w.parentSessionID === input.parentSessionID
    return true
  })
  return workers.map((w) => {
    const alive = pidAlive(w.pid)
    let taskUpdatedAt: number | undefined
    let taskPreview: string | undefined
    if (w.taskFile) {
      try {
        taskUpdatedAt = statSync(w.taskFile).mtimeMs
        taskPreview = readFileSync(w.taskFile, "utf8").trim().replace(/\s+/g, " ").slice(0, 180)
      } catch {
        taskUpdatedAt = undefined
        taskPreview = undefined
      }
    }
    return {
      sessionID: w.sessionID,
      project: path.basename(input.projectDir),
      parentSessionID: w.parentSessionID,
      alive,
      state: alive ? w.state : w.state === "blocked" ? "blocked" : "dead",
      pid: w.pid,
      round: w.round,
      last_fact_id: w.lastFactId,
      last_rc: w.lastRc ?? null,
      lastHeartbeatAt: w.lastHeartbeatAt,
      logFile: w.logFile,
      model: w.model,
      variant: w.variant,
      startedAt: w.startedAt,
      taskUpdatedAt,
      taskPreview,
      verifierModel: swarm.verifierModel,
      noProgressRounds: w.noProgressRounds,
      verificationErrorStreak: w.verificationErrorStreak,
      blockedReason: w.blockedReason,
      blockedAt: w.blockedAt,
      generation: w.generation,
      blockedTaskFingerprint: w.blockedTaskFingerprint,
      lastOutcome: w.lastOutcome,
      lastSummary: w.lastSummary,
      stopRequested: existsSync(stopPath(input.projectDir, w.sessionID)),
      restartable: (() => {
        if (alive || existsSync(stopPath(input.projectDir, w.sessionID))) return false
        if (!(w.taskFile && existsSync(w.taskFile))) return false
        const blockedSameTask =
          w.state === "blocked" &&
          w.blockedTaskFingerprint !== undefined &&
          mathWorkerTaskFingerprint(readFileSync(w.taskFile, "utf8")) === w.blockedTaskFingerprint
        if (!blockedSameTask) return true
        if (!isInfraBlockedReason(w.blockedReason)) return false
        return (w.verificationErrorStreak ?? 0) < MAX_MATH_WORKER_VERIFIER_ERROR_STREAK
      })(),
    }
  })
}

export const discoverMathWorkers = Effect.fn("MathWorker.discover")(function* (input: {
  projectDir: string
  parentSessionID: SessionID
  sessionID?: string
}) {
  const sessions = yield* Session.Service
  const summary = yield* Effect.promise(async () => {
    const facts = await new FactGraph(input.projectDir).list().catch(() => [])
    const verification = await new GlobalMemory(input.projectDir).read("verification").catch(() => [])
    const verdict = (value: unknown) => (typeof value === "string" ? value : "error")
    const latest = verification.toSorted((a, b) => b.timestamp_utc.localeCompare(a.timestamp_utc))[0]
    return {
      factCount: facts.length,
      verificationCorrect: verification.filter((entry) => verdict(entry.verdict) === "correct").length,
      verificationWrong: verification.filter((entry) => verdict(entry.verdict) === "wrong").length,
      verificationError: verification.filter((entry) => !["correct", "wrong"].includes(verdict(entry.verdict))).length,
      latestVerification: latest?.claim.slice(0, 240),
    }
  })
  const children = (yield* sessions.children(input.parentSessionID)).filter(
    (child) => child.agent === "math-worker" && (!input.sessionID || child.id === input.sessionID),
  )
  const rows = new Map(
    statusMathWorker({
      projectDir: input.projectDir,
      sessionID: input.sessionID,
      parentSessionID: input.sessionID ? undefined : input.parentSessionID,
    }).map((row) => [row.sessionID, row]),
  )
  for (const child of children) {
    const existing = rows.get(child.id)
    const taskFile = taskPath(input.projectDir, child.id)
    rows.set(child.id, {
      sessionID: child.id,
      project: path.basename(input.projectDir),
      parentSessionID: child.parentID,
      alive: existing?.alive ?? false,
      state: existing?.state ?? "missing",
      pid: existing?.pid,
      round: existing?.round,
      last_fact_id: existing?.last_fact_id,
      last_rc: existing?.last_rc,
      lastHeartbeatAt: existing?.lastHeartbeatAt,
      logFile: existing?.logFile,
      stopRequested: existing?.stopRequested ?? existsSync(stopPath(input.projectDir, child.id)),
      restartable: existing?.restartable ?? (existsSync(taskFile) && !existsSync(stopPath(input.projectDir, child.id))),
      attachable: true,
      transcriptUpdatedAt: child.time.updated,
      model: existing?.model,
      variant: existing?.variant,
      startedAt: existing?.startedAt ?? child.time.created,
      cost: child.cost,
      tokens: child.tokens
        ? child.tokens.input +
          child.tokens.output +
          child.tokens.reasoning +
          child.tokens.cache.read +
          child.tokens.cache.write
        : undefined,
      taskUpdatedAt: existing?.taskUpdatedAt,
      taskPreview: existing?.taskPreview,
      verifierModel: existing?.verifierModel ?? readSwarm(input.projectDir).verifierModel,
      noProgressRounds: existing?.noProgressRounds,
      verificationErrorStreak: existing?.verificationErrorStreak,
      blockedReason: existing?.blockedReason,
      blockedAt: existing?.blockedAt,
      generation: existing?.generation,
      blockedTaskFingerprint: existing?.blockedTaskFingerprint,
      lastOutcome: existing?.lastOutcome,
      lastSummary: existing?.lastSummary,
      ...summary,
    })
  }
  const result = [...rows.values()]
    .map((row) => ({ ...row, ...summary }))
    .sort((a, b) => a.sessionID.localeCompare(b.sessionID))
  yield* Effect.forEach(
    result.filter((row) => row.state === "dead" && !row.alive),
    (row) =>
      Effect.gen(function* () {
        const sessionID = SessionID.make(row.sessionID)
        const latest = yield* sessions.findMessage(sessionID, (message) => message.info.role === "assistant")
        if (Option.isNone(latest)) return
        if (latest.value.info.role !== "assistant" || latest.value.info.time.completed) return
        log.info("math worker death reconcile start", {
          sessionID: row.sessionID,
          parentSessionID: input.parentSessionID,
          pid: row.pid,
          round: row.round,
          messageID: latest.value.info.id,
        })
        yield* sessions.finalizeOrphanedAssistant(sessionID, {
          abortSource: "orphan-finalizer",
          abortReason: "Detached math-worker process is no longer alive.",
        })
        log.info("math worker death reconcile finish", {
          sessionID: row.sessionID,
          parentSessionID: input.parentSessionID,
          pid: row.pid,
          messageID: latest.value.info.id,
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.warn("math worker death reconcile failed", {
              sessionID: row.sessionID,
              parentSessionID: input.parentSessionID,
              pid: row.pid,
              cause,
            }),
          ),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  )
  return result
})

export function readMathWorkerTask(projectDir: string, sessionID: string): MathWorkerTaskInfo {
  const file = taskPath(projectDir, sessionID)
  return {
    sessionID,
    project: path.basename(projectDir),
    task: readFileSync(file, "utf8"),
    updatedAt: statSync(file).mtimeMs,
  }
}

export function updateMathWorkerTask(projectDir: string, sessionID: string, task: string): MathWorkerTaskInfo {
  const next = task.trim()
  if (!next) throw new Error("math worker TASK cannot be empty")
  if (next.length > 100_000) throw new Error("math worker TASK is too large")
  const file = taskPath(projectDir, sessionID)
  if (!existsSync(file)) throw new Error(`math worker TASK is missing: ${file}`)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${next}\n`, "utf8")
  renameSync(tmp, file)
  const taskFingerprint = mathWorkerTaskFingerprint(next)
  const worker = readSwarm(projectDir).workers[sessionID]
  if (worker) {
    patchWorker(projectDir, sessionID, {
      taskFingerprint,
      ...(worker.state === "blocked"
        ? {
            state: "dead" as const,
            blockedTaskFingerprint: undefined,
            blockedReason: undefined,
            blockedAt: undefined,
            noProgressRounds: 0,
            verificationErrorStreak: 0,
          }
        : {}),
    })
  }
  log.info("math worker task updated", { sessionID, projectDir, length: next.length, taskFingerprint })
  return readMathWorkerTask(projectDir, sessionID)
}

export function stopMathWorker(input: { projectDir: string; sessionID: string; force?: boolean }): StatusResult {
  const swarm = readSwarm(input.projectDir)
  const worker = swarm.workers[input.sessionID]
  if (!worker) {
    log.warn("math worker stop missing", { sessionID: input.sessionID, projectDir: input.projectDir })
    return { sessionID: input.sessionID, alive: false, state: "missing" }
  }
  const marker = stopPath(input.projectDir, input.sessionID)
  const signal = input.force ? "SIGKILL" : "SIGTERM"
  const aliveBefore = pidAlive(worker.pid)
  log.info("math worker stop start", {
    sessionID: input.sessionID,
    projectDir: input.projectDir,
    pid: worker.pid,
    round: worker.round,
    state: worker.state,
    force: input.force === true,
    signal,
    marker,
    markerPresent: existsSync(marker),
    aliveBefore,
  })
  mkdirSync(path.dirname(marker), { recursive: true })
  writeFileSync(marker, `${Date.now()}\n`, "utf8")
  log.info("math worker stop marker written", { sessionID: input.sessionID, pid: worker.pid, marker })
  patchWorker(input.projectDir, input.sessionID, { state: "stopping" })
  log.info("math worker stop state patched", { sessionID: input.sessionID, pid: worker.pid, state: "stopping" })
  if (aliveBefore) {
    log.info("math worker stop signal start", { sessionID: input.sessionID, pid: worker.pid, signal })
    try {
      killProcessGroup(worker.pid, signal)
      log.info("math worker stop signal sent", { sessionID: input.sessionID, pid: worker.pid, signal })
    } catch (error) {
      const aliveAfterError = pidAlive(worker.pid)
      const message = error instanceof Error ? error.message : String(error)
      log.warn("math worker stop signal error", {
        sessionID: input.sessionID,
        pid: worker.pid,
        signal,
        aliveAfterError,
        error: message,
      })
      if (aliveAfterError) throw error
    }
  }
  const alive = pidAlive(worker.pid)
  if (!alive) {
    patchWorker(input.projectDir, input.sessionID, { state: "dead" })
    log.info("math worker stop state patched", { sessionID: input.sessionID, pid: worker.pid, state: "dead" })
  }
  log.info("math worker stop finish", {
    sessionID: input.sessionID,
    pid: worker.pid,
    signal: aliveBefore ? signal : undefined,
    aliveBefore,
    aliveAfter: alive,
    state: alive ? "stopping" : "dead",
  })
  return {
    sessionID: input.sessionID,
    alive,
    state: alive ? "stopping" : "dead",
    pid: worker.pid,
    round: worker.round,
    last_fact_id: worker.lastFactId,
    last_rc: worker.lastRc ?? null,
    lastHeartbeatAt: worker.lastHeartbeatAt,
    logFile: worker.logFile,
  }
}

export const writeHeartbeat = Effect.fn("MathWorker.heartbeat")(function* (input: {
  sessionID: SessionID
  round: number
  projectDir: string
  generation?: number
}) {
  const sessions = yield* Session.Service
  yield* sessions.get(input.sessionID)
  const worker = readSwarm(input.projectDir).workers[input.sessionID]
  if (input.generation !== undefined && worker?.generation !== input.generation) {
    log.warn("math worker stale heartbeat ignored", {
      sessionID: input.sessionID,
      round: input.round,
      eventGeneration: input.generation,
      currentGeneration: worker?.generation,
    })
    return
  }
  const messageID = MessageID.ascending()
  const now = Date.now()
  yield* sessions.updateMessage({
    id: messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: now },
    agent: "math-worker",
    model: { providerID: ProviderID.opencode, modelID: ModelID.make("math-heartbeat") },
  })
  yield* sessions.updatePart({
    id: PartID.ascending(),
    sessionID: input.sessionID,
    messageID,
    type: "text",
    text: `math-worker heartbeat round=${input.round} ts=${now}`,
    synthetic: true,
    time: { start: now, end: now },
  })
  const stopRequested = existsSync(stopPath(input.projectDir, input.sessionID))
  patchWorker(input.projectDir, input.sessionID, {
    lastHeartbeatAt: now,
    round: input.round,
    state: stopRequested ? "stopping" : "running",
  })
  log.info("math worker heartbeat", { sessionID: input.sessionID, round: input.round, stopRequested })
})

export const MAX_WORKER_PROBLEM_STATEMENT_CHARS = 20_000

/**
 * Workers are confined to the problem workspace and never see the parent
 * session, so PROBLEM.md is their only copy of the operator's definitions.
 */
export function readProblemStatement(projectDir: string): string | undefined {
  const file = layout(projectDir).problem
  if (!existsSync(file)) return undefined
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= MAX_WORKER_PROBLEM_STATEMENT_CHARS) return trimmed
  return (
    trimmed.slice(0, MAX_WORKER_PROBLEM_STATEMENT_CHARS) +
    `\n\n[PROBLEM.md truncated at ${MAX_WORKER_PROBLEM_STATEMENT_CHARS} characters]`
  )
}

export function buildWorkerKickoff(input: {
  task: string
  round: number
  generation?: number
  taskFingerprint?: string
  problemStatement?: string
}): string {
  return [
    `You are math-worker round ${input.round}.`,
    ...(input.generation === undefined ? [] : [`Worker generation: ${input.generation}.`]),
    ...(input.taskFingerprint ? [`TASK fingerprint: ${input.taskFingerprint}.`] : []),
    "Read and execute the assigned TASK below. Continue from shared math-truth memory rather than restarting from scratch.",
    "Search verified facts before relying on prior work. Global memory and prior reports are hypotheses, never proof bricks.",
    "Record useful plans, obstacles, dead ends, and partial findings with math-truth memory tools while working.",
    "Submit a self-contained statement and proof through math-truth fact_submit only when every step is justified. Cite only verified fact_id values as predecessors.",
    "When the entire assigned TASK is discharged by an accepted fact chain, put the exact standalone line MATH_WORKER_TASK_COMPLETE in your final response. Never emit it for partial progress, a rejected submission, or an open gap.",
    "Do not run code or spawn subagents. If the problem remains open, preserve progress in shared memory and finish the round normally.",
    ...(input.problemStatement === undefined
      ? []
      : [
          "",
          "# Problem statement",
          "The operator's complete problem statement — the authoritative source for every definition, notation, and constant convention. The TASK may abbreviate it; when they appear to disagree, work from this statement.",
          input.problemStatement,
        ]),
    "",
    "# Assigned TASK",
    input.task.trim(),
  ].join("\n")
}

export const WORKER_TASK_COMPLETE_MARKER = "MATH_WORKER_TASK_COMPLETE"

export function hasWorkerCompletionMarker(message: MessageV2.WithParts): boolean {
  if (message.info.role !== "assistant") return false
  return message.parts.some(
    (part) =>
      part.type === "text" && part.text.split(/\r?\n/).some((line) => line.trim() === WORKER_TASK_COMPLETE_MARKER),
  )
}

export function completedWorkerFactId(
  message: MessageV2.WithParts,
  lastFactId: string | undefined,
): string | undefined {
  if (!lastFactId || !hasWorkerCompletionMarker(message)) return
  return lastFactId
}

export function latestAcceptedFactId(messages: MessageV2.WithParts[]): string | undefined {
  for (const message of messages.toReversed()) {
    for (const part of message.parts.toReversed()) {
      if (part.type !== "tool" || part.tool !== "math-truth_fact_submit" || part.state.status !== "completed") continue
      try {
        const output: unknown = JSON.parse(part.state.output)
        if (!output || typeof output !== "object" || Array.isArray(output)) continue
        const record = output as Record<string, unknown>
        if (record.accepted === true && typeof record.fact_id === "string") return record.fact_id
      } catch {
        continue
      }
    }
  }
}

export function workerRoundSignals(messages: MessageV2.WithParts | MessageV2.WithParts[]): {
  submissions: number
  verificationErrors: number
  acceptedFactId?: string
} {
  let submissions = 0
  let verificationErrors = 0
  let acceptedFactId: string | undefined
  const list = Array.isArray(messages) ? messages : [messages]
  for (const part of list.flatMap((message) => message.parts)) {
    if (part.type !== "tool" || part.tool !== "math-truth_fact_submit" || part.state.status !== "completed") continue
    submissions += 1
    try {
      const output: unknown = JSON.parse(part.state.output)
      if (!output || typeof output !== "object" || Array.isArray(output)) continue
      const record = output as Record<string, unknown>
      if (record.accepted === true && typeof record.fact_id === "string") acceptedFactId = record.fact_id
      if (record.verdict === "error" || typeof record.error === "string") verificationErrors += 1
    } catch {
      verificationErrors += 1
    }
  }
  return { submissions, verificationErrors, acceptedFactId }
}

export function mathWorkerTaskFingerprint(task: string): string {
  return createHash("sha256").update(task.trim()).digest("hex")
}

export function advanceMathWorkerProgress(input: {
  previousTaskFingerprint?: string
  taskFingerprint: string
  previousFactId?: string
  factId?: string
  noProgressRounds: number
  verificationErrorStreak: number
  verificationErrors: number
}) {
  const taskChanged =
    input.previousTaskFingerprint !== undefined && input.previousTaskFingerprint !== input.taskFingerprint
  const factAdvanced = input.factId !== undefined && input.factId !== input.previousFactId
  const noProgressRounds = taskChanged || factAdvanced ? 0 : input.noProgressRounds + 1
  const verificationErrorStreak = factAdvanced
    ? 0
    : input.verificationErrors > 0
      ? input.verificationErrorStreak + 1
      : 0
  const blockedReason =
    verificationErrorStreak >= MAX_MATH_WORKER_VERIFIER_ERROR_STREAK
      ? `verifier-error-streak:${verificationErrorStreak}`
      : noProgressRounds >= MAX_MATH_WORKER_NO_PROGRESS_ROUNDS
        ? `no-progress-rounds:${noProgressRounds}`
        : undefined
  return { taskChanged, factAdvanced, noProgressRounds, verificationErrorStreak, blockedReason }
}

export function classifyMathWorkerDispatch(input: {
  completedFactId?: string
  superseded: boolean
  submissions: number
  verificationErrors: number
  acceptedFactId?: string
}): { kind: "completed" | "superseded" | "blocked"; reason?: string } {
  if (input.superseded) return { kind: "superseded" }
  if (input.completedFactId) return { kind: "completed" }
  if (input.verificationErrors > 0) return { kind: "blocked", reason: `verifier-errors:${input.verificationErrors}` }
  if (input.acceptedFactId) return { kind: "blocked", reason: "accepted-fact-not-task-complete" }
  if (input.submissions > 0) return { kind: "blocked", reason: "submission-not-accepted" }
  return { kind: "blocked", reason: "round-ended-without-current-fact" }
}

/** Blocked reasons caused by infrastructure (verifier/model/process), not by the TASK content. */
export function isInfraBlockedReason(reason: string | undefined): boolean {
  return reason === "worker-round-failed" || (reason ?? "").startsWith("verifier-errors:")
}

export const runWorkerRound = Effect.fn("MathWorker.round")(function* (input: {
  sessionID: SessionID
  projectDir: string
  round: number
  model?: string
  variant?: string
  generation?: number
}) {
  const taskFile = taskPath(input.projectDir, input.sessionID)
  const task = readFileSync(taskFile, "utf8")
  const problemStatement = readProblemStatement(input.projectDir)
  const prompts = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const mcp = yield* MCP.Service
  const mcpStatus = yield* mcp.status()
  const mcpTools = yield* mcp.tools()
  const before = new Set((yield* sessions.messages({ sessionID: input.sessionID })).map((message) => message.info.id))
  log.info("math worker prompt start", {
    sessionID: input.sessionID,
    round: input.round,
    taskFile,
    configContentPresent: Boolean(process.env.OPENCODE_CONFIG_CONTENT),
    configHasMathTruth: process.env.OPENCODE_CONFIG_CONTENT?.includes('"math-truth"') === true,
    mcpStatus,
    mcpTools: Object.keys(mcpTools),
    problemStatementChars: problemStatement?.length ?? 0,
  })
  const result = yield* prompts.prompt({
    sessionID: input.sessionID,
    agent: "math-worker",
    model: input.model ? Provider.parseModel(input.model) : undefined,
    variant: input.variant,
    parts: [
      {
        type: "text",
        text: buildWorkerKickoff({
          task,
          round: input.round,
          generation: input.generation,
          taskFingerprint: mathWorkerTaskFingerprint(task),
          problemStatement,
        }),
      },
    ],
  })
  const messages = yield* sessions.messages({ sessionID: input.sessionID })
  const roundMessages = messages.filter((message) => !before.has(message.info.id))
  const lastFactId = latestAcceptedFactId(messages)
  const completionMarkerPresent = hasWorkerCompletionMarker(result)
  const signals = workerRoundSignals(roundMessages)
  const completedFactId = completedWorkerFactId(result, signals.acceptedFactId)
  const currentTaskFingerprint = mathWorkerTaskFingerprint(readFileSync(taskFile, "utf8"))
  const taskFingerprint = mathWorkerTaskFingerprint(task)
  const currentWorker = readSwarm(input.projectDir).workers[input.sessionID]
  const staleGeneration = input.generation !== undefined && currentWorker?.generation !== input.generation
  const superseded = currentTaskFingerprint !== taskFingerprint || staleGeneration
  const stopRequested = existsSync(stopPath(input.projectDir, input.sessionID))
  if (!superseded) {
    patchWorker(input.projectDir, input.sessionID, {
      lastHeartbeatAt: Date.now(),
      round: input.round,
      state: stopRequested ? "stopping" : "running",
      lastRc: result.info.role === "assistant" && !result.info.error ? 0 : 1,
      lastFactId,
    })
  }
  log.info("math worker prompt finish", {
    sessionID: input.sessionID,
    round: input.round,
    role: result.info.role,
    error: result.info.role === "assistant" ? result.info.error?.name : undefined,
    lastFactId,
    completionMarkerPresent,
    completionAccepted: completedFactId !== undefined,
    acceptedFactInRound: signals.acceptedFactId,
    roundMessageCount: roundMessages.length,
    superseded,
    staleGeneration,
    stopRequested,
  })
  return { result, completedFactId, lastFactId, signals, taskFingerprint, superseded }
})

export const runWorkerLoop = Effect.fn("MathWorker.loop")(function* (input: {
  sessionID: string
  projectDir: string
  intervalMs: number
  heartbeatOnly?: boolean
  model?: string
  variant?: string
  generation?: number
}) {
  const sessionID = SessionID.make(input.sessionID)
  const sessions = yield* Session.Service
  const persisted = yield* sessions.get(sessionID)
  if (AppFileSystem.resolve(persisted.directory) !== AppFileSystem.resolve(input.projectDir)) {
    log.warn("math worker session owner migration required", {
      sessionID,
      fromDirectory: persisted.directory,
      toDirectory: input.projectDir,
    })
    const relocated = yield* sessions.relocate(sessionID, { preserveProject: true })
    if (AppFileSystem.resolve(relocated.directory) !== AppFileSystem.resolve(input.projectDir)) {
      return yield* Effect.die(
        new Error(`math worker ${sessionID} could not relocate to ${input.projectDir}: ${relocated.directory}`),
      )
    }
  }
  mkdirSync(path.dirname(stopPath(input.projectDir, sessionID)), { recursive: true })
  mkdirSync(layout(input.projectDir).logs, { recursive: true })
  const existing = readSwarm(input.projectDir).workers[sessionID]
  const generation = input.generation ?? existing?.generation ?? 0
  if (existing?.generation !== undefined && generation !== existing.generation) {
    log.warn("math worker stale generation refused", {
      sessionID,
      expectedGeneration: existing.generation,
      receivedGeneration: generation,
    })
    return existing.round ?? 0
  }
  const parent = existing?.parentSessionID
    ? yield* sessions.get(SessionID.make(existing.parentSessionID)).pipe(Effect.option)
    : Option.none()
  const parentDirectory = Option.isSome(parent) ? parent.value.directory : input.projectDir
  const parentServerUrl = process.env.OPENCODE_MATH_PARENT_SERVER_URL
  upsertWorker(input.projectDir, {
    sessionID,
    parentSessionID: existing?.parentSessionID,
    pid: process.pid,
    state: "running",
    startedAt: existing?.startedAt ?? Date.now(),
    logFile: existing?.logFile ?? path.join(layout(input.projectDir).logs, `worker-${sessionID}.log`),
    taskFile: existing?.taskFile,
    round: existing?.round ?? 0,
    lastFactId: existing?.lastFactId,
    lastRc: existing?.lastRc,
    lastHeartbeatAt: existing?.lastHeartbeatAt,
    model: input.model ?? existing?.model,
    variant: input.variant ?? existing?.variant,
    taskFingerprint: existing?.taskFingerprint,
    noProgressRounds: existing?.noProgressRounds,
    verificationErrorStreak: existing?.verificationErrorStreak,
    blockedReason: existing?.blockedReason,
    blockedAt: existing?.blockedAt,
    generation,
    blockedTaskFingerprint: existing?.blockedTaskFingerprint,
    lastOutcome: existing?.lastOutcome,
    lastSummary: existing?.lastSummary,
  })
  let round = existing?.round ?? 0
  const marker = stopPath(input.projectDir, sessionID)
  let completedFactId: string | undefined
  let blockedReason: string | undefined
  log.info("math worker loop start", { sessionID, intervalMs: input.intervalMs, pid: process.pid, marker })
  while (!existsSync(marker)) {
    round += 1
    const startedAt = Date.now()
    log.info("math worker round start", { sessionID, round, pid: process.pid, markerPresent: false })
    if (input.heartbeatOnly)
      yield* writeHeartbeat({ sessionID, round, projectDir: input.projectDir, generation })
    else {
      const exit = yield* runWorkerRound({
        sessionID,
        round,
        projectDir: input.projectDir,
        model: input.model ?? existing?.model,
        variant: input.variant ?? existing?.variant,
        generation,
      }).pipe(Effect.exit)
      if (Exit.isFailure(exit)) {
        const summary = Cause.pretty(exit.cause).slice(0, 1_000)
        const current = readSwarm(input.projectDir).workers[sessionID]
        if (current?.generation === generation) {
          patchWorker(input.projectDir, sessionID, {
            state: "dead",
            round,
            lastRc: 1,
            lastOutcome: "failed",
            lastSummary: summary,
            verificationErrorStreak: (current.verificationErrorStreak ?? 0) + 1,
          })
          yield* notifyParent({
            serverUrl: parentServerUrl,
            parentSessionID: existing?.parentSessionID,
            workerSessionID: sessionID,
            directory: parentDirectory,
            eventID: `failed_${generation}_${round}`,
            kind: "failed",
            round,
            reason: "worker-round-failed",
            summary: `Math worker round failed before producing a decision. ${summary}`,
            generation,
            taskFingerprint: current.taskFingerprint ?? "",
          })
        }
        blockedReason = "worker-round-failed"
        break
      }
      const outcome = exit.value
      const decision = classifyMathWorkerDispatch({
        completedFactId: outcome.completedFactId,
        superseded: outcome.superseded,
        submissions: outcome.signals.submissions,
        verificationErrors: outcome.signals.verificationErrors,
        acceptedFactId: outcome.signals.acceptedFactId,
      })
      if (decision.kind === "superseded") {
        const current = readSwarm(input.projectDir).workers[sessionID]
        if (current?.generation !== generation) break
        patchWorker(input.projectDir, sessionID, {
          round,
          taskFingerprint: mathWorkerTaskFingerprint(readFileSync(taskPath(input.projectDir, sessionID), "utf8")),
          lastOutcome: "superseded",
          lastSummary: "TASK changed while the previous worker round was running; stale output was discarded.",
        })
        log.info("math worker stale round discarded after TASK revision", { sessionID, round, generation })
        continue
      }
      completedFactId = decision.kind === "completed" ? outcome.completedFactId : undefined
      const finalSummary = outcome.result.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, 1_000)
      const current = readSwarm(input.projectDir).workers[sessionID]
      if (current?.generation !== generation || current.taskFingerprint !== outcome.taskFingerprint) {
        log.warn("math worker terminal result fenced", {
          sessionID,
          round,
          generation,
          currentGeneration: current?.generation,
          taskFingerprint: outcome.taskFingerprint,
          currentTaskFingerprint: current?.taskFingerprint,
        })
        break
      }
      log.info("math worker completion decision", {
        sessionID,
        round,
        completed: completedFactId !== undefined,
        completedFactId,
      })
      if (completedFactId) {
        writeFileSync(marker, `completed fact_id=${completedFactId} round=${round} ts=${Date.now()}\n`, "utf8")
        patchWorker(input.projectDir, sessionID, {
          state: "stopping",
          lastFactId: completedFactId,
          lastOutcome: "completed",
          lastSummary: finalSummary,
        })
        log.info("math worker completion marker written", { sessionID, round, completedFactId, marker })
        yield* notifyParent({
          serverUrl: parentServerUrl,
          parentSessionID: existing?.parentSessionID,
          workerSessionID: sessionID,
          directory: parentDirectory,
          eventID: `completed_${round}_${completedFactId}`,
          kind: "completed",
          round,
          factID: completedFactId,
          summary: `Math worker completed its assigned lane with accepted fact ${completedFactId}.\nWorker report: ${finalSummary || "(no final text)"}`,
          generation,
          taskFingerprint: outcome.taskFingerprint,
        })
      } else {
        blockedReason = decision.reason ?? "round-ended-without-current-fact"
        patchWorker(input.projectDir, sessionID, {
          state: "blocked",
          round,
          taskFingerprint: outcome.taskFingerprint,
          blockedTaskFingerprint: outcome.taskFingerprint,
          blockedReason,
          blockedAt: Date.now(),
          noProgressRounds: 1,
          verificationErrorStreak: outcome.signals.verificationErrors > 0 ? 1 : 0,
          lastRc: 1,
          lastOutcome: "blocked",
          lastSummary: finalSummary,
        })
        log.warn("math worker blocked", {
          sessionID,
          round,
          blockedReason,
          submissions: outcome.signals.submissions,
          verificationErrors: outcome.signals.verificationErrors,
        })
        yield* notifyParent({
          serverUrl: parentServerUrl,
          parentSessionID: existing?.parentSessionID,
          workerSessionID: sessionID,
          directory: parentDirectory,
          eventID: `blocked_${generation}_${round}_${blockedReason}`,
          kind: "blocked",
          round,
          reason: blockedReason,
          summary: `Math worker stopped after one complete dispatch without a current-round accepted completion fact. The parent must inspect shared memory and revise the TASK or dependencies before retrying.\nWorker report: ${finalSummary || "(no final text)"}`,
          generation,
          taskFingerprint: outcome.taskFingerprint,
        })
      }
    }
    log.info("math worker round finish", {
      sessionID,
      round,
      pid: process.pid,
      durationMs: Date.now() - startedAt,
      markerPresent: existsSync(marker),
    })
    if (blockedReason || completedFactId) break
    yield* Effect.sleep(Duration.millis(input.intervalMs))
  }
  const final = readSwarm(input.projectDir).workers[sessionID]
  if (!blockedReason && final?.generation === generation) patchWorker(input.projectDir, sessionID, { state: "dead", lastRc: 0 })
  log.info("math worker loop stop", {
    sessionID,
    round,
    pid: process.pid,
    marker,
    markerPresent: existsSync(marker),
    reason: completedFactId ? "task-complete" : blockedReason ? "blocked" : "stop-requested",
    completedFactId,
    blockedReason,
  })
  return round
})

export * as MathWorker from "./worker"
