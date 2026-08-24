import { mkdirSync, writeFileSync, existsSync } from "fs"
import path from "path"
import { Duration, Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { layout, mathRoot, taskPath } from "./layout"
import { killProcessGroup, pidAlive, selfArgv, spawnDetached } from "./spawn"
import { patchWorker, readSwarm, stopPath, upsertWorker, type SwarmWorker } from "./swarm"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "math.worker" })

export type StartInput = {
  parentSessionID: SessionID
  title: string
  task: string
  project?: string
  intervalMs?: number
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
  alive: boolean
  state: SwarmWorker["state"] | "missing"
  pid?: number
  round?: number
  last_fact_id?: string
  last_rc?: number | null
  lastHeartbeatAt?: number
  logFile?: string
}

function resolveProjectDir(workspace: string, project?: string): string {
  return mathRoot(workspace, project || path.basename(workspace) || "default")
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
  ])
  const spawn = input.spawn ?? spawnDetached
  const { pid } = spawn({
    argv,
    cwd: directory,
    logFile,
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
  })

  return {
    sessionID: session.id,
    pid,
    state: "running" as const,
    projectDir,
    logFile,
  } satisfies StartResult
})

export function statusMathWorker(input: { projectDir: string; sessionID?: string; parentSessionID?: string }): StatusResult[] {
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
      alive,
      state: alive ? w.state : "dead",
      pid: w.pid,
      round: w.round,
      last_fact_id: w.lastFactId,
      last_rc: w.lastRc ?? null,
      lastHeartbeatAt: w.lastHeartbeatAt,
      logFile: w.logFile,
    }
  })
}

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

export const runWorkerLoop = Effect.fn("MathWorker.loop")(function* (input: {
  sessionID: string
  projectDir: string
  intervalMs: number
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
  })
  let round = existing?.round ?? 0
  log.info("math worker loop start", { sessionID, intervalMs: input.intervalMs, pid: process.pid })
  while (!existsSync(stopPath(input.projectDir, sessionID))) {
    round += 1
    yield* writeHeartbeat({ sessionID, round, projectDir: input.projectDir })
    yield* Effect.sleep(Duration.millis(input.intervalMs))
  }
  patchWorker(input.projectDir, sessionID, { state: "dead", lastRc: 0 })
  log.info("math worker loop stop", { sessionID, round })
  return round
})

export * as MathWorker from "./worker"
