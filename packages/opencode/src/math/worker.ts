import { closeSync, mkdirSync, openSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "fs"
import path from "path"
import { Duration, Effect } from "effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import { MCP } from "@/mcp"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { layout, mathRoot, taskPath } from "./layout"
import { killProcessGroup, pidAlive, selfArgv, spawnDetached } from "./spawn"
import { patchWorker, readSwarm, stopPath, upsertWorker, type SwarmWorker } from "./swarm"
import * as Log from "@opencode-ai/core/util/log"
import { parse as parseJsonc } from "jsonc-parser"

const log = Log.create({ service: "math.worker" })

export type StartInput = {
  parentSessionID: SessionID
  title: string
  task: string
  project?: string
  intervalMs?: number
  model?: string
  variant?: string
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
}

export type EnsureResult = StartResult & {
  restarted: boolean
  previousPid?: number
  round: number
}

function resolveProjectDir(workspace: string, project?: string): string {
  return mathRoot(workspace, project || path.basename(workspace) || "default")
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
  return JSON.stringify({
    ...base,
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
          ...(process.env.OPENCODE_MATH_VERIFY_MODEL
            ? { OPENCODE_MATH_VERIFY_MODEL: process.env.OPENCODE_MATH_VERIFY_MODEL }
            : {}),
        },
        timeout: 3_600_000,
      },
    },
  })
}

export const startMathWorker = Effect.fn("MathWorker.start")(function* (input: StartInput) {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    parentID: input.parentSessionID,
    title: input.title,
    agent: "math-worker",
  })
  const directory = session.directory
  const projectDir = resolveProjectDir(directory, input.project)
  mkdirSync(layout(projectDir).tasks, { recursive: true })
  mkdirSync(layout(projectDir).logs, { recursive: true })
  log.info("math worker session created", { sessionID: session.id, parent: input.parentSessionID })

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
    directory,
    ...(input.intervalMs ? ["--interval", String(input.intervalMs)] : []),
    ...((input.model ?? process.env.OPENCODE_MATH_WORKER_MODEL)
      ? ["--model", (input.model ?? process.env.OPENCODE_MATH_WORKER_MODEL)!]
      : []),
    ...(input.variant ? ["--variant", input.variant] : []),
  ])
  const spawn = input.spawn ?? spawnDetached
  const { pid } = spawn({
    argv,
    cwd: directory,
    logFile,
    env: {
      OPENCODE_CONFIG_CONTENT: workerMcpConfig({
        projectDir,
        workspace: directory,
        sessionID: session.id,
        baseContent: process.env.OPENCODE_CONFIG_CONTENT,
      }),
      OPENCODE_MATH_WORKSPACE: directory,
    },
  })
  log.info("math worker spawned", { sessionID: session.id, pid, argv: argv.join(" ") })

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
  spawn?: StartInput["spawn"]
}) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(input.sessionID)
  if (session.agent !== "math-worker") throw new Error(`session is not a math-worker: ${input.sessionID}`)

  const existing = readSwarm(input.projectDir).workers[input.sessionID]
  const taskFile = existing?.taskFile ?? taskPath(input.projectDir, input.sessionID)
  const logFile = existing?.logFile ?? path.join(layout(input.projectDir).logs, `worker-${input.sessionID}.log`)
  const stop = stopPath(input.projectDir, input.sessionID)
  if (!existsSync(taskFile)) throw new Error(`math worker TASK is missing: ${taskFile}`)
  if (existsSync(stop)) throw new Error(`math worker has a stop request; refusing restart: ${input.sessionID}`)
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
    session.directory,
    ...(input.intervalMs ? ["--interval", String(input.intervalMs)] : []),
    ...((input.model ?? existing?.model) ? ["--model", (input.model ?? existing?.model)!] : []),
    ...((input.variant ?? existing?.variant) ? ["--variant", (input.variant ?? existing?.variant)!] : []),
  ])
  const spawn = input.spawn ?? spawnDetached
  const { pid } = spawn({
    argv,
    cwd: session.directory,
    logFile,
    env: {
      OPENCODE_CONFIG_CONTENT: workerMcpConfig({
        projectDir: input.projectDir,
        workspace: session.directory,
        sessionID: input.sessionID,
        baseContent: process.env.OPENCODE_CONFIG_CONTENT,
      }),
      OPENCODE_MATH_WORKSPACE: session.directory,
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
    return {
      sessionID: w.sessionID,
      project: path.basename(input.projectDir),
      parentSessionID: w.parentSessionID,
      alive,
      state: alive ? w.state : "dead",
      pid: w.pid,
      round: w.round,
      last_fact_id: w.lastFactId,
      last_rc: w.lastRc ?? null,
      lastHeartbeatAt: w.lastHeartbeatAt,
      logFile: w.logFile,
      model: w.model,
      variant: w.variant,
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
    })
  }
  return [...rows.values()].sort((a, b) => a.sessionID.localeCompare(b.sessionID))
})

export function stopMathWorker(input: { projectDir: string; sessionID: string; force?: boolean }): StatusResult {
  const swarm = readSwarm(input.projectDir)
  const worker = swarm.workers[input.sessionID]
  if (!worker) {
    return { sessionID: input.sessionID, alive: false, state: "missing" }
  }
  mkdirSync(path.dirname(stopPath(input.projectDir, input.sessionID)), { recursive: true })
  writeFileSync(stopPath(input.projectDir, input.sessionID), `${Date.now()}\n`, "utf8")
  patchWorker(input.projectDir, input.sessionID, { state: "stopping" })
  if (input.force && pidAlive(worker.pid)) {
    log.info("math worker force kill", { sessionID: input.sessionID, pid: worker.pid })
    killProcessGroup(worker.pid, "SIGKILL")
  }
  const alive = pidAlive(worker.pid)
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
  patchWorker(input.projectDir, input.sessionID, {
    lastHeartbeatAt: now,
    round: input.round,
    state: "running",
  })
  log.info("math worker heartbeat", { sessionID: input.sessionID, round: input.round })
})

export function buildWorkerKickoff(input: { task: string; round: number }): string {
  return [
    `You are math-worker round ${input.round}.`,
    "Read and execute the assigned TASK below. Continue from shared math-truth memory rather than restarting from scratch.",
    "Search verified facts before relying on prior work. Global memory and prior reports are hypotheses, never proof bricks.",
    "Record useful plans, obstacles, dead ends, and partial findings with math-truth memory tools while working.",
    "Submit a self-contained statement and proof through math-truth fact_submit only when every step is justified. Cite only verified fact_id values as predecessors.",
    "Do not run code or spawn subagents. If the problem remains open, preserve progress in shared memory and finish the round normally.",
    "",
    "# Assigned TASK",
    input.task.trim(),
  ].join("\n")
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
  patchWorker(input.projectDir, input.sessionID, {
    lastHeartbeatAt: Date.now(),
    round: input.round,
    state: "running",
    lastRc: result.info.role === "assistant" && !result.info.error ? 0 : 1,
    lastFactId,
  })
  log.info("math worker prompt finish", {
    sessionID: input.sessionID,
    round: input.round,
    role: result.info.role,
    error: result.info.role === "assistant" ? result.info.error?.name : undefined,
    lastFactId,
  })
  return result
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
  mkdirSync(path.dirname(stopPath(input.projectDir, sessionID)), { recursive: true })
  mkdirSync(layout(input.projectDir).logs, { recursive: true })
  const existing = readSwarm(input.projectDir).workers[sessionID]
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
  })
  let round = existing?.round ?? 0
  log.info("math worker loop start", { sessionID, intervalMs: input.intervalMs, pid: process.pid })
  while (!existsSync(stopPath(input.projectDir, sessionID))) {
    round += 1
    if (input.heartbeatOnly) yield* writeHeartbeat({ sessionID, round, projectDir: input.projectDir })
    else
      yield* runWorkerRound({
        sessionID,
        round,
        projectDir: input.projectDir,
        model: input.model ?? existing?.model,
        variant: input.variant ?? existing?.variant,
      })
    yield* Effect.sleep(Duration.millis(input.intervalMs))
  }
  patchWorker(input.projectDir, sessionID, { state: "dead", lastRc: 0 })
  log.info("math worker loop stop", { sessionID, round })
  return round
})

export * as MathWorker from "./worker"
