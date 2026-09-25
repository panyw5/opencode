import path from "node:path"
import { realpathSync } from "node:fs"
import { Database, and, eq } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { ProjectLocation } from "@/project/location"
import { MathProblemTable, MathProblemWorkerTable } from "./registry.sql"
import { mathRoot } from "./layout"
import { readMathProblemIdentity } from "./identity"

const canonical = (value: string) => {
  try {
    return realpathSync.native(value)
  } catch {
    return path.resolve(value)
  }
}

export type MathProblemRegistryRecord = {
  parentSessionID: string
  problemID: string
  workerSessionID: string
  ownerProjectID: string
  ownerLocationID?: string
  orchestratorSessionID: string
  legacy: boolean
}

function validate(input: { parentSessionID: string; workerSessionID: string; problemID: string }) {
  const result = Database.use((db) => {
    const parent = db.select().from(SessionTable).where(eq(SessionTable.id, input.parentSessionID as never)).get()
    const worker = db.select().from(SessionTable).where(eq(SessionTable.id, input.workerSessionID as never)).get()
    if (!parent || parent.agent !== "math-orchestrator") throw new Error("Math registry parent is not an orchestrator")
    if (!worker || worker.agent !== "math-worker" || worker.parent_id !== parent.id) throw new Error("Math registry worker ownership mismatch")
    if (worker.project_id !== parent.project_id) throw new Error("Math registry project mismatch")
    const location = parent.location_id ? ProjectLocation.getByID(parent.location_id) : undefined
    if (parent.location_id && !location) throw new Error("Math registry owner location is missing")
    if (location && location.projectID !== parent.project_id) throw new Error("Math registry location project mismatch")
    const ownerDirectory = location?.directory ?? parent.directory
    const expected = mathRoot(ownerDirectory, input.problemID)
    const identity = readMathProblemIdentity(worker.directory)
    const selected = path.resolve(worker.directory) === path.resolve(expected) ? identity : readMathProblemIdentity(expected)
    if (
      !selected ||
      selected.ownerProjectID !== parent.project_id ||
      selected.orchestratorSessionID !== parent.id ||
      canonical(selected.ownerDirectory) !== canonical(ownerDirectory)
    ) {
      throw new Error("Math registry ownership marker mismatch")
    }
    if (path.resolve(worker.directory) !== path.resolve(expected) && selected.legacyAdoption?.workerSessionID !== worker.id) {
      throw new Error("Math registry legacy adoption mismatch")
    }
    return {
      parent,
      worker,
      location,
      legacy: Boolean(selected.legacyAdoption),
      ownerDirectory,
      ownerLocationID: location?.id,
    }
  })
  return result
}

export function registerProblemWorker(input: { parentSessionID: string; workerSessionID: string; problemID: string }): void {
  const { parent, worker, location, legacy, ownerLocationID } = validate(input)
  Database.use((db) => {
    const now = Date.now()
    db.transaction((tx) => {
      const existingProblem = tx.select().from(MathProblemTable).where(and(eq(MathProblemTable.parent_session_id, parent.id), eq(MathProblemTable.problem_id, input.problemID))).get()
      if (existingProblem && (existingProblem.owner_project_id !== parent.project_id || existingProblem.owner_location_id !== (ownerLocationID ?? null) || existingProblem.orchestrator_session_id !== parent.id)) {
        throw new Error("Math registry problem ownership conflict")
      }
      const existingWorker = tx.select().from(MathProblemWorkerTable).where(eq(MathProblemWorkerTable.worker_session_id, worker.id)).get()
      if (existingWorker && (existingWorker.parent_session_id !== parent.id || existingWorker.problem_id !== input.problemID)) {
        throw new Error("Math registry worker is already mapped to another problem")
      }
      tx.insert(MathProblemTable)
        .values({
          parent_session_id: parent.id,
          problem_id: input.problemID,
          owner_project_id: parent.project_id,
          owner_location_id: ownerLocationID ?? null,
          orchestrator_session_id: parent.id,
          legacy,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: [MathProblemTable.parent_session_id, MathProblemTable.problem_id],
          set: { time_updated: now, legacy },
        })
        .run()
      tx.insert(MathProblemWorkerTable)
        .values({ parent_session_id: parent.id, problem_id: input.problemID, worker_session_id: worker.id })
        .onConflictDoNothing()
        .run()
    })
  })
}

export function findByWorker(workerSessionID: string): MathProblemRegistryRecord | undefined {
  const result = Database.use((db) => {
    const row = db.select().from(MathProblemWorkerTable).where(eq(MathProblemWorkerTable.worker_session_id, workerSessionID as never)).get()
    if (!row) return undefined
    const problem = db.select().from(MathProblemTable).where(and(eq(MathProblemTable.parent_session_id, row.parent_session_id), eq(MathProblemTable.problem_id, row.problem_id))).get()
    if (!problem) return undefined
    return {
      parentSessionID: row.parent_session_id,
      problemID: row.problem_id,
      workerSessionID: row.worker_session_id,
      ownerProjectID: problem.owner_project_id,
      ownerLocationID: problem.owner_location_id ?? undefined,
      orchestratorSessionID: problem.orchestrator_session_id,
      legacy: problem.legacy,
    }
  })
  if (result) {
    const authority = validate({ parentSessionID: result.parentSessionID, workerSessionID, problemID: result.problemID })
    if (
      result.ownerProjectID !== authority.parent.project_id ||
      result.ownerLocationID !== (authority.ownerLocationID ?? undefined) ||
      result.orchestratorSessionID !== authority.parent.id
    ) {
      throw new Error("Math registry row no longer matches persisted ownership")
    }
  }
  return result
}

export function listByParent(parentSessionID: string): MathProblemRegistryRecord[] {
  const workers = Database.use((db) => db.select().from(MathProblemWorkerTable).where(eq(MathProblemWorkerTable.parent_session_id, parentSessionID as never)).all())
  return workers.flatMap((row) => {
    const found = findByWorker(row.worker_session_id)
    return found ? [found] : []
  })
}

export * as MathRegistry from "./registry"
