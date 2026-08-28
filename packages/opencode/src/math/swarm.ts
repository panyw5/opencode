import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import path from "path"
import { layout } from "./layout"

export type WorkerState = "running" | "stopping" | "dead"

export type SwarmWorker = {
  sessionID: string
  parentSessionID?: string
  pid: number
  state: WorkerState
  startedAt: number
  lastHeartbeatAt?: number
  lastFactId?: string
  lastRc?: number | null
  logFile: string
  taskFile?: string
  round?: number
  model?: string
  variant?: string
}

export type SwarmFile = {
  projectDir: string
  parentSessionID?: string
  verifierModel?: string
  workers: Record<string, SwarmWorker>
}

export function swarmPath(projectDir: string): string {
  return layout(projectDir).swarm
}

export function stopPath(projectDir: string, sessionID: string): string {
  return path.join(projectDir, "stop", sessionID)
}

export function clearStop(projectDir: string, sessionID: string): boolean {
  try {
    unlinkSync(stopPath(projectDir, sessionID))
    return true
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    if (code === "ENOENT") return false
    throw error
  }
}

export function readSwarm(projectDir: string): SwarmFile {
  const file = swarmPath(projectDir)
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { projectDir, workers: {} }
    }
    const workers = parsed.workers && typeof parsed.workers === "object" ? parsed.workers : {}
    return {
      projectDir,
      parentSessionID: typeof parsed.parentSessionID === "string" ? parsed.parentSessionID : undefined,
      verifierModel: typeof parsed.verifierModel === "string" ? parsed.verifierModel : undefined,
      workers,
    }
  } catch {
    return { projectDir, workers: {} }
  }
}

export function writeSwarm(projectDir: string, swarm: SwarmFile): void {
  const file = swarmPath(projectDir)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + ".tmp"
  writeFileSync(tmp, JSON.stringify(swarm, null, 2) + "\n", "utf8")
  renameSync(tmp, file)
}

export function upsertWorker(projectDir: string, worker: SwarmWorker): SwarmFile {
  const swarm = readSwarm(projectDir)
  swarm.projectDir = projectDir
  if (worker.parentSessionID) swarm.parentSessionID = worker.parentSessionID
  swarm.workers[worker.sessionID] = worker
  writeSwarm(projectDir, swarm)
  return swarm
}

export function patchWorker(projectDir: string, sessionID: string, patch: Partial<SwarmWorker>): SwarmFile {
  const swarm = readSwarm(projectDir)
  const prev = swarm.workers[sessionID]
  if (!prev) return swarm
  swarm.workers[sessionID] = { ...prev, ...patch, sessionID }
  writeSwarm(projectDir, swarm)
  return swarm
}

export function setVerifierModel(projectDir: string, model: string): SwarmFile {
  const swarm = readSwarm(projectDir)
  swarm.projectDir = projectDir
  swarm.verifierModel = model
  writeSwarm(projectDir, swarm)
  return swarm
}

export * as MathSwarm from "./swarm"
