import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ensureMathProblemIdentity, readMathProblemIdentity } from "../../src/math/identity"

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
})
