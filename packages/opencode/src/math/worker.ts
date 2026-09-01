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
import { Duration, Effect, Option } from "effect"
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

  const taskFile = taskPath(projectDir, session.id)
  writeFileSync(taskFile, input.task.trim() + "\n", "utf8")
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
  const argv = selfArgv([
    "math",
    "worker",
    "--session",
    input.sessionID,
    "--project-dir",
    input.projectDir,
    "--dir",
    input.projectDir,
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
    taskFingerprint: existing?.taskFingerprint,
    noProgressRounds: 0,
    verificationErrorStreak: 0,
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
      stopRequested: existsSync(stopPath(input.projectDir, w.sessionID)),
      restartable:
        !alive && !existsSync(stopPath(input.projectDir, w.sessionID)) && Boolean(w.taskFile && existsSync(w.taskFile)),
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
  log.info("math worker task updated", { sessionID, projectDir, length: next.length })
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
}) {
  const sessions = yield* Session.Service
  yield* sessions.get(input.sessionID)
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

export function buildWorkerKickoff(input: { task: string; round: number }): string {
  return [
    `You are math-worker round ${input.round}.`,
    "Read and execute the assigned TASK below. Continue from shared math-truth memory rather than restarting from scratch.",
    "Search verified facts before relying on prior work. Global memory and prior reports are hypotheses, never proof bricks.",
    "Record useful plans, obstacles, dead ends, and partial findings with math-truth memory tools while working.",
    "Submit a self-contained statement and proof through math-truth fact_submit only when every step is justified. Cite only verified fact_id values as predecessors.",
    "When the entire assigned TASK is discharged by an accepted fact chain, put the exact standalone line MATH_WORKER_TASK_COMPLETE in your final response. Never emit it for partial progress, a rejected submission, or an open gap.",
    "Do not run code or spawn subagents. If the problem remains open, preserve progress in shared memory and finish the round normally.",
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

export function workerRoundSignals(message: MessageV2.WithParts): {
  submissions: number
  verificationErrors: number
  acceptedFactId?: string
} {
  let submissions = 0
  let verificationErrors = 0
  let acceptedFactId: string | undefined
  for (const part of message.parts) {
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

export const runWorkerRound = Effect.fn("MathWorker.round")(function* (input: {
  sessionID: SessionID
  projectDir: string
  round: number
  model?: string
  variant?: string
}) {
  const taskFile = taskPath(input.projectDir, input.sessionID)
  const task = readFileSync(taskFile, "utf8")
  const prompts = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const mcp = yield* MCP.Service
  const mcpStatus = yield* mcp.status()
  const mcpTools = yield* mcp.tools()
  log.info("math worker prompt start", {
    sessionID: input.sessionID,
    round: input.round,
    taskFile,
    configContentPresent: Boolean(process.env.OPENCODE_CONFIG_CONTENT),
    configHasMathTruth: process.env.OPENCODE_CONFIG_CONTENT?.includes('"math-truth"') === true,
    mcpStatus,
    mcpTools: Object.keys(mcpTools),
  })
  const result = yield* prompts.prompt({
    sessionID: input.sessionID,
    agent: "math-worker",
    model: input.model ? Provider.parseModel(input.model) : undefined,
    variant: input.variant,
    parts: [{ type: "text", text: buildWorkerKickoff({ task, round: input.round }) }],
  })
  const lastFactId = latestAcceptedFactId(yield* sessions.messages({ sessionID: input.sessionID }))
  const completionMarkerPresent = hasWorkerCompletionMarker(result)
  const completedFactId = completedWorkerFactId(result, lastFactId)
  const signals = workerRoundSignals(result)
  const stopRequested = existsSync(stopPath(input.projectDir, input.sessionID))
  patchWorker(input.projectDir, input.sessionID, {
    lastHeartbeatAt: Date.now(),
    round: input.round,
    state: stopRequested ? "stopping" : "running",
    lastRc: result.info.role === "assistant" && !result.info.error ? 0 : 1,
    lastFactId,
  })
  log.info("math worker prompt finish", {
    sessionID: input.sessionID,
    round: input.round,
    role: result.info.role,
    error: result.info.role === "assistant" ? result.info.error?.name : undefined,
    lastFactId,
    completionMarkerPresent,
    completionAccepted: completedFactId !== undefined,
    stopRequested,
  })
  return { result, completedFactId, lastFactId, signals, taskFingerprint: mathWorkerTaskFingerprint(task) }
})

export const runWorkerLoop = Effect.fn("MathWorker.loop")(function* (input: {
  sessionID: string
  projectDir: string
  intervalMs: number
  heartbeatOnly?: boolean
  model?: string
  variant?: string
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
  })
  let round = existing?.round ?? 0
  let lastFactId = existing?.lastFactId
  let taskFingerprint = existing?.taskFingerprint
  let noProgressRounds = existing?.noProgressRounds ?? 0
  let verificationErrorStreak = existing?.verificationErrorStreak ?? 0
  const marker = stopPath(input.projectDir, sessionID)
  let completedFactId: string | undefined
  let blockedReason: string | undefined
  log.info("math worker loop start", { sessionID, intervalMs: input.intervalMs, pid: process.pid, marker })
  while (!existsSync(marker)) {
    round += 1
    const startedAt = Date.now()
    log.info("math worker round start", { sessionID, round, pid: process.pid, markerPresent: false })
    if (input.heartbeatOnly) yield* writeHeartbeat({ sessionID, round, projectDir: input.projectDir })
    else {
      const outcome = yield* runWorkerRound({
        sessionID,
        round,
        projectDir: input.projectDir,
        model: input.model ?? existing?.model,
        variant: input.variant ?? existing?.variant,
      })
      completedFactId = outcome.completedFactId
      const progress = advanceMathWorkerProgress({
        previousTaskFingerprint: taskFingerprint,
        taskFingerprint: outcome.taskFingerprint,
        previousFactId: lastFactId,
        factId: outcome.lastFactId,
        noProgressRounds,
        verificationErrorStreak,
        verificationErrors: outcome.signals.verificationErrors,
      })
      const factAdvanced = progress.factAdvanced
      noProgressRounds = progress.noProgressRounds
      verificationErrorStreak = progress.verificationErrorStreak
      taskFingerprint = outcome.taskFingerprint
      lastFactId = outcome.lastFactId
      blockedReason = progress.blockedReason
      patchWorker(input.projectDir, sessionID, {
        taskFingerprint,
        noProgressRounds,
        verificationErrorStreak,
        ...(blockedReason ? { state: "blocked", blockedReason, blockedAt: Date.now(), lastRc: 1 } : {}),
      })
      log.info("math worker completion decision", {
        sessionID,
        round,
        completed: completedFactId !== undefined,
        completedFactId,
      })
      if (completedFactId) {
        writeFileSync(marker, `completed fact_id=${completedFactId} round=${round} ts=${Date.now()}\n`, "utf8")
        patchWorker(input.projectDir, sessionID, { state: "stopping", lastFactId: completedFactId })
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
          summary: `Math worker completed its assigned lane with accepted fact ${completedFactId}.`,
        })
      } else if (blockedReason) {
        log.warn("math worker blocked", {
          sessionID,
          round,
          blockedReason,
          noProgressRounds,
          verificationErrorStreak,
        })
        yield* notifyParent({
          serverUrl: parentServerUrl,
          parentSessionID: existing?.parentSessionID,
          workerSessionID: sessionID,
          directory: parentDirectory,
          eventID: `blocked_${round}_${blockedReason}`,
          kind: "blocked",
          round,
          reason: blockedReason,
          summary:
            verificationErrorStreak >= MAX_MATH_WORKER_VERIFIER_ERROR_STREAK
              ? "Math worker stopped after repeated verifier infrastructure errors. The verifier or model path needs intervention before retrying."
              : "Math worker stopped after repeated rounds without an accepted fact or TASK revision. The parent must revise dependencies or strategy before retrying.",
        })
      } else if (factAdvanced && outcome.lastFactId) {
        yield* notifyParent({
          serverUrl: parentServerUrl,
          parentSessionID: existing?.parentSessionID,
          workerSessionID: sessionID,
          directory: parentDirectory,
          eventID: `progress_${outcome.lastFactId}`,
          kind: "progress",
          round,
          factID: outcome.lastFactId,
          summary: `Math worker produced a new accepted fact ${outcome.lastFactId}.`,
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
    if (blockedReason) break
    if (!completedFactId) yield* Effect.sleep(Duration.millis(input.intervalMs))
  }
  if (!blockedReason) patchWorker(input.projectDir, sessionID, { state: "dead", lastRc: 0 })
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
