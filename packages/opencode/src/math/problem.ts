import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "path"
import { layout } from "./layout"

export const MIN_PROBLEM_STATEMENT_CHARS = 200

const POINTER_PATTERN = /@[\p{L}\p{N}][\p{L}\p{N} ._\-/\\()（）]*\.[A-Za-z0-9]{1,8}\b/gu

export function findPointerReferences(text: string): string[] {
  return [...text.matchAll(POINTER_PATTERN)].map((match) => match[0])
}

export function assertNoPointerReferences(text: string, label: string): void {
  const found = findPointerReferences(text)
  if (found.length === 0) return
  throw new Error(
    `${label} references external files (${found.join(", ")}); workers cannot read outside the problem workspace. ` +
      `Inline the referenced content verbatim into ${label}, or stage the file via math_worker_start's references parameter and cite the staged copy under references/.`,
  )
}

export function writeProblemStatement(root: string, problem: string): string {
  const next = problem.trim()
  if (!next) throw new Error("problem statement cannot be empty")
  if (next.length < MIN_PROBLEM_STATEMENT_CHARS) {
    throw new Error(
      `problem statement is only ${next.length} characters — too short to carry the statement and its definitions ` +
        `(minimum ${MIN_PROBLEM_STATEMENT_CHARS}); include every definition, formula, notation, and constant convention verbatim`,
    )
  }
  assertNoPointerReferences(next, "PROBLEM.md")
  const file = layout(root).problem
  if (existsSync(file)) {
    const current = readFileSync(file, "utf8").trim()
    if (current !== next) {
      throw new Error(
        `PROBLEM.md already exists with different content (${file}); the problem statement is the immutable goal. ` +
          `If it genuinely changed, remove the file explicitly first or start a new problem id.`,
      )
    }
    return file
  }
  mkdirSync(root, { recursive: true })
  writeFileSync(file, `${next}\n`, "utf8")
  return file
}

export function ensureProblemStatementReady(root: string): void {
  const file = layout(root).problem
  if (!existsSync(file)) {
    throw new Error(
      `PROBLEM.md is missing in the problem workspace (${file}). math_worker_start refuses to dispatch a worker ` +
        `without the complete verbatim problem statement — persist it first (every definition, formula, notation, ` +
        `and constant convention), or pass it via the problem parameter.`,
    )
  }
  const text = readFileSync(file, "utf8").trim()
  if (text.length < MIN_PROBLEM_STATEMENT_CHARS) {
    throw new Error(
      `PROBLEM.md is only ${text.length} characters (${file}) — too short to carry the statement and its definitions ` +
        `(minimum ${MIN_PROBLEM_STATEMENT_CHARS}). Inline the full verbatim statement.`,
    )
  }
  assertNoPointerReferences(text, "PROBLEM.md")
}

export type ReferenceProvenance = {
  source: string
  name: string
  size: number
  sha256: string
  stagedAt: string
}

export type StagedReferences = {
  dir: string
  staged: ReferenceProvenance[]
}

export function referencesDir(root: string): string {
  return path.join(root, "references")
}

export function stageReferences(root: string, sources: string[]): StagedReferences {
  const dir = referencesDir(root)
  if (sources.length === 0) return { dir, staged: [] }
  mkdirSync(dir, { recursive: true })
  const manifestPath = path.join(dir, "PROVENANCE.json")
  let previous: ReferenceProvenance[] = []
  if (existsSync(manifestPath)) {
    try {
      previous = JSON.parse(readFileSync(manifestPath, "utf8")) as ReferenceProvenance[]
    } catch {
      previous = []
    }
  }
  const staged: ReferenceProvenance[] = []
  for (const source of sources) {
    if (!existsSync(source)) throw new Error(`reference file not found: ${source}`)
    const info = statSync(source)
    if (!info.isFile()) throw new Error(`reference must be a regular file: ${source}`)
    const name = path.basename(source)
    if (!name || name === "PROVENANCE.json") {
      throw new Error(`reference file name is not usable: ${source}`)
    }
    const content = readFileSync(source)
    const sha256 = createHash("sha256").update(content).digest("hex")
    const dest = path.join(dir, name)
    if (existsSync(dest)) {
      const existing = createHash("sha256").update(readFileSync(dest)).digest("hex")
      if (existing !== sha256) {
        throw new Error(
          `references/${name} already exists with different content (${dest}); rename the source file or use a different problem workspace`,
        )
      }
    } else {
      copyFileSync(source, dest)
    }
    staged.push({
      source,
      name,
      size: content.byteLength,
      sha256,
      stagedAt: new Date().toISOString(),
    })
  }
  const merged = previous.filter((entry) => !staged.some((item) => item.name === entry.name && item.sha256 === entry.sha256))
  writeFileSync(manifestPath, `${JSON.stringify([...merged, ...staged], null, 2)}\n`, "utf8")
  return { dir, staged }
}

export * as Problem from "./problem"
