import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkMathWorkerOwnership, ensureMathProblemIdentity, readMathProblemIdentity } from "../../src/math/identity"
import { inspectMathWorkspace } from "../../src/math/workspace"

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(path.join(tmpdir(), "math-problem-identity-"))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("MathProblem ownership", () => {
  test("persists a versioned owner record and is idempotent", () => {
    const workspace = root()
    const directory = path.join(workspace, ".math", "problems", "lemma-a")
    const input = {
      directory,
      ownerProjectID: "project-parent",
      ownerDirectory: workspace,
      orchestratorSessionID: "ses-parent",
    }

    const first = ensureMathProblemIdentity(input)
    expect(first).toMatchObject({
      version: 1,
      problemID: "lemma-a",
      ownerProjectID: "project-parent",
      ownerDirectory: workspace,
      orchestratorSessionID: "ses-parent",
    })
    expect(ensureMathProblemIdentity(input)).toEqual(first)
    expect(readMathProblemIdentity(directory)).toEqual(first)
  })

  test("will not claim a populated legacy workspace without ownership evidence", () => {
    const workspace = root()
    const directory = path.join(workspace, ".math", "problems", "legacy")
    mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(directory, "swarm.json"), "{}\n")

    expect(() =>
      ensureMathProblemIdentity({
        directory,
        ownerProjectID: "project-parent",
        ownerDirectory: workspace,
        orchestratorSessionID: "ses-parent",
      }),
    ).toThrow("ownership is unknown")
    expect(readMathProblemIdentity(directory)).toBeUndefined()
  })

  test("rejects a different owner for an already registered problem", () => {
    const workspace = root()
    const directory = path.join(workspace, ".math", "problems", "lemma-b")
    ensureMathProblemIdentity({
      directory,
      ownerProjectID: "project-parent",
      ownerDirectory: workspace,
      orchestratorSessionID: "ses-parent",
    })

    expect(() =>
      ensureMathProblemIdentity({
        directory,
        ownerProjectID: "project-other",
        ownerDirectory: "/tmp/other",
        orchestratorSessionID: "ses-other",
      }),
    ).toThrow("owned by a different project")
  })

  test("accepts a worker runtime inside the problem while retaining the parent owner", () => {
    const workspace = root()
    const directory = path.join(workspace, ".math", "problems", "lemma-c")
    const identity = ensureMathProblemIdentity({
      directory,
      ownerProjectID: "project-parent",
      ownerDirectory: workspace,
      orchestratorSessionID: "ses-parent",
    })
    const input = {
      identity,
      projectDir: directory,
      ownerDirectory: workspace,
      ownerProjectID: "project-parent",
      runtimeDirectory: directory,
      projectRuntimeRequired: true,
    }

    expect(checkMathWorkerOwnership(input).valid).toBe(true)
    expect(checkMathWorkerOwnership({ ...input, ownerDirectory: path.join(workspace, "wrong") }).valid).toBe(false)
    expect(checkMathWorkerOwnership({ ...input, runtimeDirectory: workspace }).valid).toBe(false)
    expect(checkMathWorkerOwnership({ ...input, ownerProjectID: "project-other" }).valid).toBe(false)
  })

  test("reads an existing identity through a symlink alias of the owner root", () => {
    const workspace = root()
    const aliasParent = root()
    const alias = path.join(aliasParent, "workspace")
    symlinkSync(workspace, alias)
    const directory = path.join(workspace, ".math", "problems", "lemma-d")
    const identity = ensureMathProblemIdentity({
      directory,
      ownerProjectID: "project-parent",
      ownerDirectory: workspace,
      orchestratorSessionID: "ses-parent",
    })

    expect(readMathProblemIdentity(path.join(alias, ".math", "problems", "lemma-d"))).toEqual(identity)
    expect(inspectMathWorkspace(path.join(alias, ".math", "problems", "lemma-d"))).toEqual(identity)
  })
})
