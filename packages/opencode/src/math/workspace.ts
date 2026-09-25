import { existsSync, lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { assertProjectName, layout, mathRoot, taskPath } from "./layout"
import { ensureMathProblemIdentity, readMathProblemIdentity, type MathProblemIdentity } from "./identity"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ProjectLocation } from "@/project/location"
import { Database, eq } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"

/** Return true when candidate is the root itself or is below root. */
export function isMathPathWithin(root: string, candidate: string): boolean {
  const parent = path.resolve(root)
  const child = path.resolve(candidate)
  return child === parent || child.startsWith(`${parent}${path.sep}`)
}

const samePhysicalDirectory = (left: string, right: string) => {
  try {
    return realpathSync.native(left) === realpathSync.native(right)
  } catch {
    return path.resolve(left) === path.resolve(right)
  }
}

/**
 * Validate a path used by the math runtime. Existing symlinks are rejected so
 * path checks cannot be bypassed after validation by replacing a directory.
 */
export function assertMathPathWithin(root: string, candidate: string, label: string): string {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  if (!isMathPathWithin(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${label} escapes Math workspace: ${candidate}`)
  }
  let current = resolvedCandidate
  while (isMathPathWithin(resolvedRoot, current)) {
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${current}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("contains a symbolic link")) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (current === resolvedRoot) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolvedCandidate
}

export type MathWorkerPaths = {
  taskFile: string
  logFile: string
}

export type MathWorkspace = {
  problemID: string
  ownerProjectID: string
  ownerDirectory: string
  problemDirectory: string
  layout: ReturnType<typeof layout>
  identity: MathProblemIdentity
  workerPaths(sessionID: string): MathWorkerPaths
}

export type MathWorkerBootstrap = {
  workerSessionID: string
  parentSessionID: string
  ownerProjectID: string
  ownerDirectory: string
  problemDirectory: string
  problemID: string
  runtimeDirectory: string
}

/** Read-only resolver usable before Instance/Session services are bootstrapped. */
export function resolveMathWorkerBootstrap(sessionID: string, projectDirectory?: string): MathWorkerBootstrap {
  const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, SessionID.make(sessionID))).get())
  if (!row) throw new Error(`math worker session not found: ${sessionID}`)
  if (row.agent !== "math-worker" || !row.parent_id) throw new Error(`session is not a math-worker child: ${sessionID}`)
  const parent = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, SessionID.make(row.parent_id!))).get())
  if (!parent || parent.agent !== "math-orchestrator") throw new Error(`math worker owner session is invalid: ${row.parent_id}`)
  if (row.project_id !== parent.project_id) throw new Error(`math worker project differs from owner: ${sessionID}`)
  const location = parent.location_id ? ProjectLocation.getByID(parent.location_id) : undefined
  if (parent.location_id && !location) throw new Error(`math owner location is missing: ${parent.location_id}`)
  if (location && String(location.projectID) !== String(parent.project_id)) throw new Error(`math owner location project mismatch`)
  const ownerInput = path.resolve(location?.directory ?? parent.directory)
  const ownerDirectory = existsSync(ownerInput) ? realpathSync(ownerInput) : ownerInput
  const problemID = path.basename(projectDirectory ?? row.directory)
  assertProjectName(problemID)
  const problemDirectory = path.resolve(projectDirectory ?? row.directory)
  const expectedDirectory = path.resolve(mathRoot(ownerDirectory, problemID))
  const runtimeDirectory = path.resolve(row.directory)
  const identity = inspectMathWorkspace(problemDirectory)
  if (!isMathPathWithin(ownerDirectory, realpathSync.native(problemDirectory))) {
    throw new Error(`math problem workspace escapes its owner: ${problemDirectory}`)
  }
  if (
    identity.ownerProjectID !== String(parent.project_id) ||
    identity.orchestratorSessionID !== String(parent.id)
  ) {
    throw new Error(`math problem ownership marker does not match persisted sessions: ${problemDirectory}`)
  }
  if (runtimeDirectory !== problemDirectory) {
    const legacy = identity.legacyAdoption
    if (!legacy || legacy.workerSessionID !== sessionID || legacy.parentSessionID !== parent.id) {
      throw new Error(`math worker runtime does not match the selected problem workspace: ${sessionID}`)
    }
  }
  if (!samePhysicalDirectory(problemDirectory, expectedDirectory)) {
    const legacy = readMathProblemIdentity(problemDirectory)?.legacyAdoption
    if (!legacy || legacy.workerSessionID !== sessionID || legacy.parentSessionID !== parent.id) {
      throw new Error(`math worker runtime directory is not the derived problem workspace: ${problemDirectory}`)
    }
  }
  return {
    workerSessionID: sessionID,
    parentSessionID: row.parent_id,
    ownerProjectID: String(parent.project_id),
    ownerDirectory,
    problemDirectory,
    problemID,
    runtimeDirectory,
  }
}

/** Derive all mutable math paths from stable IDs; callers should not persist alternatives. */
export function deriveMathWorkerPaths(problemDirectory: string, sessionID: string): MathWorkerPaths {
  const safeSessionID = assertProjectName(sessionID)
  const root = path.resolve(problemDirectory)
  const taskFile = assertMathPathWithin(root, taskPath(root, safeSessionID), "worker TASK path")
  const logFile = assertMathPathWithin(root, path.join(layout(root).logs, `worker-${safeSessionID}.log`), "worker log path")
  return { taskFile, logFile }
}

export function resolveMathWorkspace(input: {
  ownerDirectory: string
  ownerProjectID: string
  problemID: string
  orchestratorSessionID: string
  problemDirectory?: string
  legacyAdoption?: { workerSessionID: string; parentSessionID: string }
}): MathWorkspace {
  const problemID = assertProjectName(input.problemID)
  const ownerInput = path.resolve(input.ownerDirectory)
  const ownerDirectory = existsSync(ownerInput) ? realpathSync(ownerInput) : ownerInput
  const problemDirectory = path.resolve(input.problemDirectory ?? mathRoot(ownerDirectory, problemID))
  const expectedDirectory = path.resolve(mathRoot(ownerDirectory, problemID))
  if (!samePhysicalDirectory(problemDirectory, expectedDirectory) && !input.legacyAdoption) {
    throw new Error(`Math problem directory must be derived from owner and problem ID: ${problemDirectory}`)
  }
  assertMathPathWithin(ownerDirectory, problemDirectory, "Math problem directory")
  const identity = ensureMathProblemIdentity({
    directory: problemDirectory,
    ownerProjectID: input.ownerProjectID,
    ownerDirectory,
    orchestratorSessionID: input.orchestratorSessionID,
    legacyAdoption: input.legacyAdoption,
  })
  return {
    problemID,
    ownerProjectID: input.ownerProjectID,
    ownerDirectory,
    problemDirectory,
    layout: layout(problemDirectory),
    identity,
    workerPaths: (sessionID) => deriveMathWorkerPaths(problemDirectory, sessionID),
  }
}

/** Validate an existing workspace without creating or relocating it. */
export function inspectMathWorkspace(problemDirectory: string): MathProblemIdentity {
  const directory = path.resolve(problemDirectory)
  const components = directory.split(path.sep)
  const mathIndex = components.lastIndexOf(".math")
  if (mathIndex < 0) throw new Error(`MathProblem directory is not under .math: ${directory}`)
  let current = components.slice(0, mathIndex).join(path.sep) || path.sep
  for (const component of components.slice(mathIndex)) {
    current = path.join(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`MathProblem managed path is a symbolic link: ${current}`)
    } catch (error) {
      if (error instanceof Error && error.message.includes("managed path")) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const identity = readMathProblemIdentity(directory)
  if (!identity) throw new Error(`MathProblem ownership is missing: ${directory}`)
  if (realpathSync.native(identity.directory) !== realpathSync.native(directory)) {
    throw new Error(`MathProblem directory mismatch: ${directory}`)
  }
  return identity
}

/**
 * Resolve an existing Math workspace from persisted session and location
 * authority. Callers cannot override the owner directory or project identity.
 */
export function resolveExistingMathWorkspaceFromSessions(input: {
  sessions: Session.Interface
  parentSessionID: string
  workerSessionID?: string
  problemID?: string
}): Effect.Effect<MathWorkspace, Error> {
  return Effect.gen(function* () {
    const fail = (message: string) => Effect.fail(new Error(message))
    const parent = yield* input.sessions.get(SessionID.make(input.parentSessionID)).pipe(Effect.mapError((error) => error as Error))
    const location = parent.locationID ? ProjectLocation.getByID(parent.locationID) : undefined
    if (parent.locationID && !location) return yield* fail(`Math owner location is missing: ${parent.locationID}`)
    if (parent.agent !== "math-orchestrator") return yield* fail(`Math owner session is not an orchestrator: ${parent.id}`)
    const ownerInput = path.resolve(location?.directory ?? parent.directory)
    const ownerDirectory = existsSync(ownerInput) ? realpathSync(ownerInput) : ownerInput
    const ownerProjectID = String(location?.projectID ?? parent.projectID)
    if (location && String(location.projectID) !== String(parent.projectID)) {
      return yield* fail(`Math owner location project mismatch: ${location.projectID} != ${parent.projectID}`)
    }
    let problemDirectory: string | undefined
    let workerID: string | undefined
    if (input.workerSessionID) {
      const worker = yield* input.sessions.get(SessionID.make(input.workerSessionID)).pipe(Effect.mapError((error) => error as Error))
      if (String(worker.parentID ?? "") !== String(parent.id))
        return yield* fail(`Math worker is not a child of the requested owner session: ${input.workerSessionID}`)
      if (worker.agent !== "math-worker") return yield* fail(`Math session is not a worker: ${worker.id}`)
      if (String(worker.projectID) !== String(parent.projectID))
        return yield* fail(`Math worker project differs from its owner: ${worker.id}`)
      workerID = worker.id
      problemDirectory = path.resolve(worker.directory)
    }
    const problemID = yield* Effect.try({
      try: () => assertProjectName(input.problemID ?? (problemDirectory ? path.basename(problemDirectory) : parent.id)),
      catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
    })
    const expectedDirectory = path.resolve(mathRoot(ownerDirectory, problemID))
    if (problemDirectory && !samePhysicalDirectory(problemDirectory, expectedDirectory)) {
      const identity = readMathProblemIdentity(problemDirectory)
      const expectedIdentity = readMathProblemIdentity(expectedDirectory)
      const adopted = [identity, expectedIdentity].find(
        (record) => record?.legacyAdoption?.workerSessionID === workerID,
      )
      if (!adopted) return yield* fail(`Math worker directory is not the derived problem workspace: ${problemDirectory}`)
      // Legacy sessions may retain their owner/runtime directory; the
      // explicit adoption marker authorizes using the registered problem root.
      problemDirectory = expectedDirectory
    }
    const identity = yield* Effect.try({
      try: () => inspectMathWorkspace(problemDirectory ?? expectedDirectory),
      catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
    })
    const contained = yield* Effect.try({
      try: () => isMathPathWithin(ownerDirectory, realpathSync.native(identity.directory)),
      catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
    })
    if (!contained) return yield* fail(`Math problem workspace escapes its owner: ${identity.directory}`)
    const identityOwnerInput = path.resolve(identity.ownerDirectory)
    const identityOwner = existsSync(identityOwnerInput) ? realpathSync(identityOwnerInput) : identityOwnerInput
    if (identity.ownerProjectID !== ownerProjectID || identityOwner !== ownerDirectory) {
      return yield* fail(`Math problem ownership does not match the persisted owner session: ${problemID}`)
    }
    if (identity.orchestratorSessionID !== String(parent.id))
      return yield* fail(`Math problem orchestrator does not match owner session: ${problemID}`)
    return {
      problemID,
      ownerProjectID,
      ownerDirectory,
      problemDirectory: path.resolve(identity.directory),
      layout: layout(identity.directory),
      identity,
      workerPaths: (sessionID) => deriveMathWorkerPaths(identity.directory, sessionID),
    }
  })
}

export * as MathWorkspace from "./workspace"
