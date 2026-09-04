import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  MIN_PROBLEM_STATEMENT_CHARS,
  assertNoPointerReferences,
  ensureProblemStatementReady,
  findPointerReferences,
  stageReferences,
  writeProblemStatement,
} from "@/math/problem"

describe("math.problem", () => {
  it("detects @file pointer references", () => {
    expect(findPointerReferences("Start from @Eisenstein series identities.md and expand.")).toEqual([
      "@Eisenstein series identities.md",
    ])
    expect(findPointerReferences("use @data/tables.csv as input")).toEqual(["@data/tables.csv"])
    expect(findPointerReferences("no pointers here, just math")).toEqual([])
    expect(findPointerReferences("a single @word without extension")).toEqual([])
  })

  it("assertNoPointerReferences names the offending files", () => {
    expect(() => assertNoPointerReferences("see @Notebook.nb for the constants", "TASK")).toThrow(
      /TASK references external files \(@Notebook\.nb\)/,
    )
    expect(() => assertNoPointerReferences("clean task body", "TASK")).not.toThrow()
  })

  it("writeProblemStatement persists verbatim, is idempotent, and refuses rewrites", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "math-problem-"))
    try {
      const statement = `${"The twisted Eisenstein series is defined by the Lambert series below. ".repeat(
        4,
      )}Prove the stated identity.`.trim()
      expect(statement.length).toBeGreaterThanOrEqual(MIN_PROBLEM_STATEMENT_CHARS)

      const file = writeProblemStatement(dir, statement)
      expect(file).toBe(path.join(dir, "PROBLEM.md"))
      expect(writeProblemStatement(dir, statement)).toBe(file)
      expect(() => writeProblemStatement(dir, `${statement} changed`)).toThrow(/already exists with different content/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writeProblemStatement refuses short or pointer statements", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "math-problem-"))
    try {
      expect(() => writeProblemStatement(dir, "too short")).toThrow(/too short/)
      expect(() => writeProblemStatement(dir, "x".repeat(MIN_PROBLEM_STATEMENT_CHARS + 5) + " see @notes.md")).toThrow(
        /references external files/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ensureProblemStatementReady gates on existence, size, and pointers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "math-problem-"))
    try {
      expect(() => ensureProblemStatementReady(dir)).toThrow(/PROBLEM\.md is missing/)

      writeFileSync(path.join(dir, "PROBLEM.md"), "too short")
      expect(() => ensureProblemStatementReady(dir)).toThrow(/too short to carry/)

      writeFileSync(path.join(dir, "PROBLEM.md"), `${"long enough text. ".repeat(20)}see @source.md`)
      expect(() => ensureProblemStatementReady(dir)).toThrow(/references external files/)

      writeFileSync(path.join(dir, "PROBLEM.md"), `${"a complete statement with definitions. ".repeat(10)}\n`)
      expect(() => ensureProblemStatementReady(dir)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("stageReferences copies files, is idempotent, merges provenance, and refuses conflicts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "math-root-"))
    const sources = mkdtempSync(path.join(tmpdir(), "math-src-"))
    try {
      const first = path.join(sources, "identities.md")
      writeFileSync(first, "# identities v1")
      const { dir, staged } = stageReferences(root, [first])
      expect(dir).toBe(path.join(root, "references"))
      expect(staged).toHaveLength(1)
      expect(staged[0]).toMatchObject({ name: "identities.md", source: first })
      expect(readFileSync(path.join(dir, "identities.md"), "utf8")).toBe("# identities v1")

      const second = stageReferences(root, [first])
      expect(second.staged).toHaveLength(1)
      const manifest = JSON.parse(readFileSync(path.join(dir, "PROVENANCE.json"), "utf8"))
      expect(manifest).toHaveLength(1)

      const other = path.join(sources, "tables.csv")
      writeFileSync(other, "k,value\n2,3\n")
      stageReferences(root, [other])
      const merged = JSON.parse(readFileSync(path.join(dir, "PROVENANCE.json"), "utf8"))
      expect(merged.map((entry: { name: string }) => entry.name).sort()).toEqual(["identities.md", "tables.csv"])

      writeFileSync(first, "# identities v2")
      expect(() => stageReferences(root, [first])).toThrow(/already exists with different content/)

      expect(() => stageReferences(root, [path.join(sources, "missing.md")])).toThrow(/not found/)
      mkdirSync(path.join(sources, "subdir"))
      expect(() => stageReferences(root, [path.join(sources, "subdir")])).toThrow(/regular file/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(sources, { recursive: true, force: true })
    }
  })
})
