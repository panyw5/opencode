import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"

export type MathProblemIdentity = {
  version: 1
  problemID: string
  directory: string
  ownerProjectID: string
  ownerDirectory: string
  orchestratorSessionID: string
  legacyAdoption?: { workerSessionID: string; parentSessionID: string }
}

const identityPath = (directory: string) => path.join(directory, "ownership.json")

export function hasMathProblemOwnershipMarker(directory: string): boolean {
  return existsSync(identityPath(directory))
}

function decodeIdentity(value: unknown, directory: string): MathProblemIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid MathProblem ownership record: ${identityPath(directory)}`)
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.problemID !== "string" ||
    typeof record.directory !== "string" ||
    typeof record.ownerProjectID !== "string" ||
    typeof record.ownerDirectory !== "string" ||
    typeof record.orchestratorSessionID !== "string"
  ) {
    throw new Error(`unsupported MathProblem ownership record: ${identityPath(directory)}`)
  }
  if (
    record.legacyAdoption !== undefined &&
    (!record.legacyAdoption ||
      typeof record.legacyAdoption !== "object" ||
      typeof (record.legacyAdoption as Record<string, unknown>).workerSessionID !== "string" ||
      typeof (record.legacyAdoption as Record<string, unknown>).parentSessionID !== "string")
  ) {
    throw new Error(`invalid MathProblem legacy adoption evidence: ${identityPath(directory)}`)
  }
  const result = record as MathProblemIdentity
  if (path.resolve(result.directory) !== path.resolve(directory)) {
    throw new Error(`MathProblem ownership directory mismatch: ${identityPath(directory)}`)
  }
  if (result.problemID !== path.basename(directory)) {
    throw new Error(`MathProblem ownership ID mismatch: ${identityPath(directory)}`)
  }
  return result
}

export function readMathProblemIdentity(directory: string): MathProblemIdentity | undefined {
  if (!hasMathProblemOwnershipMarker(directory)) return undefined
  const file = identityPath(directory)
  return decodeIdentity(JSON.parse(readFileSync(file, "utf8")), directory)
}

export function ensureMathProblemIdentity(input: {
  directory: string
  ownerProjectID: string
  ownerDirectory: string
  orchestratorSessionID: string
  legacyAdoption?: { workerSessionID: string; parentSessionID: string }
}): MathProblemIdentity {
  const directory = path.resolve(input.directory)
  const directoryExisted = existsSync(directory)
  mkdirSync(directory, { recursive: true })
  const file = identityPath(directory)
  const existing = readMathProblemIdentity(directory)
  if (existing) {
    if (
      existing.ownerProjectID !== input.ownerProjectID ||
      path.resolve(existing.ownerDirectory) !== path.resolve(input.ownerDirectory)
    ) {
      throw new Error(`MathProblem ${existing.problemID} is owned by a different project`)
    }
    if (existing.orchestratorSessionID !== input.orchestratorSessionID) {
      throw new Error(`MathProblem ${existing.problemID} is owned by a different orchestrator session`)
    }
    return existing
  }
  const existingFiles = readdirSync(directory).filter((name) => !/^ownership\.json\..+\.tmp$/.test(name))
  if (
    directoryExisted &&
    existingFiles.some((name) => name !== "PROBLEM.md") &&
    !input.legacyAdoption?.workerSessionID
  ) {
    throw new Error(`MathProblem ownership is unknown for existing workspace: ${directory}`)
  }
  if (input.legacyAdoption && input.legacyAdoption.parentSessionID !== input.orchestratorSessionID) {
    throw new Error(`MathProblem legacy adoption evidence does not match its orchestrator`)
  }

  const identity: MathProblemIdentity = {
    version: 1,
    problemID: path.basename(directory),
    directory,
    ownerProjectID: input.ownerProjectID,
    ownerDirectory: path.resolve(input.ownerDirectory),
    orchestratorSessionID: input.orchestratorSessionID,
    ...(input.legacyAdoption ? { legacyAdoption: input.legacyAdoption } : {}),
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    linkSync(temporary, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const raced = readMathProblemIdentity(directory)
    if (!raced) throw new Error(`MathProblem ownership record is incomplete: ${file}`)
    if (
      raced.ownerProjectID !== input.ownerProjectID ||
      path.resolve(raced.ownerDirectory) !== path.resolve(input.ownerDirectory)
    ) {
      throw new Error(`MathProblem ${raced.problemID} is owned by a different project`)
    }
    if (raced.orchestratorSessionID !== input.orchestratorSessionID) {
      throw new Error(`MathProblem ${raced.problemID} is owned by a different orchestrator session`)
    }
    return raced
  } finally {
    try {
      unlinkSync(temporary)
    } catch {}
  }
  return identity
}
