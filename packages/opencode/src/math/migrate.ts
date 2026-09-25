import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import * as Log from "@opencode-ai/core/util/log"
import { assertProjectName, mathProblemsRoot, mathRoot } from "./layout"
import { readSwarm, writeSwarm, type SwarmFile } from "./swarm"
import { pidAlive } from "./spawn"

const log = Log.create({ service: "math.migrate" })

export type MathMigrationManifest = {
  version: 1
  source: string
  target: string
  problemID: string
  migratedAt: string
  sourcePreserved: true
}

export type MathMigrationResult = {
  sourceDir: string
  projectDir: string
  manifest: MathMigrationManifest
  filesCopied: number
}

function copyDirectory(source: string, target: string): number {
  mkdirSync(target, { recursive: true })
  let copied = 0
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) throw new Error(`legacy math project contains a symbolic link: ${from}`)
    if (stat.isDirectory()) {
      copied += copyDirectory(from, to)
      continue
    }
    if (!stat.isFile()) throw new Error(`legacy math project contains an unsupported file type: ${from}`)
    copyFileSync(from, to)
    copied += 1
  }
  return copied
}

function relocated(value: string | undefined, source: string, target: string): string | undefined {
  if (!value || !path.isAbsolute(value)) return value
  const relative = path.relative(source, value)
  if (relative === "") return target
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return value
  return path.join(target, relative)
}

function rewriteSwarm(source: string, target: string): void {
  if (!existsSync(path.join(target, "swarm.json"))) return
  // Migration is the one explicit compatibility path allowed to rewrite
  // legacy absolute locations before the normal swarm validator runs.
  const parsed = JSON.parse(readFileSync(path.join(target, "swarm.json"), "utf8")) as Record<string, unknown>
  const rawWorkers = parsed.workers && typeof parsed.workers === "object" ? parsed.workers : {}
  const workers = Object.fromEntries(
    Object.entries(rawWorkers).map(([sessionID, value]) => {
      const worker = value as Record<string, unknown>
      return [
        sessionID,
        {
          ...worker,
          sessionID,
          logFile: relocated(typeof worker.logFile === "string" ? worker.logFile : undefined, source, target),
          taskFile: relocated(typeof worker.taskFile === "string" ? worker.taskFile : undefined, source, target),
        },
      ]
    }),
  )
  const swarm: SwarmFile = {
    projectDir: target,
    parentSessionID: typeof parsed.parentSessionID === "string" ? parsed.parentSessionID : undefined,
    verifierModel: typeof parsed.verifierModel === "string" ? parsed.verifierModel : undefined,
    workers: workers as SwarmFile["workers"],
  }
  writeSwarm(target, swarm)
}

export function migrateLegacyMathProject(input: {
  workspace: string
  source: string
  problem: string
  now?: Date
}): MathMigrationResult {
  const sourceName = assertProjectName(input.source)
  const problemID = assertProjectName(input.problem)
  if (sourceName === "problems") throw new Error("the .math/problems directory is not a legacy math project")

  const workspace = path.resolve(input.workspace)
  const sourceDir = path.join(workspace, ".math", sourceName)
  const projectDir = mathRoot(workspace, problemID)
  if (!existsSync(sourceDir)) throw new Error(`legacy math project does not exist: ${sourceDir}`)
  const mathContainer = path.join(workspace, ".math")
  if (lstatSync(mathContainer).isSymbolicLink()) {
    throw new Error(`legacy math container must not be a symbolic link: ${mathContainer}`)
  }
  const sourceStat = lstatSync(sourceDir)
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`legacy math project must be a real directory: ${sourceDir}`)
  }
  const active = Object.values(readSwarm(sourceDir).workers).filter((worker) => pidAlive(worker.pid))
  if (active.length > 0) {
    throw new Error(`stop all legacy math workers before migration: ${active.map((worker) => worker.sessionID).join(", ")}`)
  }
  if (existsSync(projectDir)) throw new Error(`math problem workspace already exists: ${projectDir}`)

  const problemsRoot = mathProblemsRoot(workspace)
  mkdirSync(problemsRoot, { recursive: true })
  if (lstatSync(problemsRoot).isSymbolicLink()) throw new Error(`math problems container must not be a symbolic link: ${problemsRoot}`)

  const staging = path.join(problemsRoot, `.${problemID}.migrate-${randomUUID()}`)
  log.info("legacy math migration started", { sourceDir, projectDir, staging })
  try {
    const filesCopied = copyDirectory(sourceDir, staging)
    rewriteSwarm(sourceDir, staging)
    const manifest: MathMigrationManifest = {
      version: 1,
      source: sourceDir,
      target: projectDir,
      problemID,
      migratedAt: (input.now ?? new Date()).toISOString(),
      sourcePreserved: true,
    }
    writeFileSync(path.join(staging, "MIGRATION.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8")
    renameSync(staging, projectDir)
    rewriteSwarm(staging, projectDir)
    log.info("legacy math migration completed", { sourceDir, projectDir, filesCopied })
    return { sourceDir, projectDir, manifest, filesCopied }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    log.error("legacy math migration failed", {
      sourceDir,
      projectDir,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

export * as MathMigrate from "./migrate"
