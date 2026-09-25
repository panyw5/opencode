import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { deriveMathWorkerPaths, inspectMathWorkspace, resolveMathWorkspace } from "../../src/math/workspace"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("MathWorkspace", () => {
  test("derives worker paths from IDs and rejects traversal", () => {
    const root = mkdtempSync(path.join(tmpdir(), "math-workspace-"))
    roots.push(root)
    const paths = deriveMathWorkerPaths(root, "ses_worker")
    expect(paths.taskFile).toBe(path.join(root, "TASKS", "ses_worker.md"))
    expect(paths.logFile).toBe(path.join(root, "logs", "worker-ses_worker.log"))
    expect(() => deriveMathWorkerPaths(root, "../outside")).toThrow("invalid project name")
  })

  test("creates one identity and refuses an alternate directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "math-workspace-"))
    roots.push(root)
    const workspace = resolveMathWorkspace({
      ownerDirectory: root,
      ownerProjectID: "project",
      problemID: "problem",
      orchestratorSessionID: "ses_parent",
    })
    expect(workspace.problemDirectory).toBe(path.join(realpathSync(root), ".math", "problems", "problem"))
    expect(() =>
      resolveMathWorkspace({
        ownerDirectory: root,
        ownerProjectID: "project",
        problemID: "problem",
        problemDirectory: path.join(root, "elsewhere"),
        orchestratorSessionID: "ses_parent",
      }),
    ).toThrow("must be derived")
  })

  test("rejects symlinked problem workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "math-workspace-"))
    const outside = mkdtempSync(path.join(tmpdir(), "math-outside-"))
    roots.push(root, outside)
    mkdirSync(path.join(root, ".math", "problems"), { recursive: true })
    symlinkSync(outside, path.join(root, ".math", "problems", "problem"))
    writeFileSync(path.join(outside, "PROBLEM.md"), "content")
    expect(() =>
      resolveMathWorkspace({
        ownerDirectory: root,
        ownerProjectID: "project",
        problemID: "problem",
        orchestratorSessionID: "ses_parent",
      }),
    ).toThrow("symbolic link")
  })

  test("inspection rejects a symlinked managed container", () => {
    const root = mkdtempSync(path.join(tmpdir(), "math-workspace-"))
    const outside = mkdtempSync(path.join(tmpdir(), "math-outside-"))
    roots.push(root, outside)
    const directory = path.join(root, ".math", "problems", "problem")
    const target = path.join(outside, "problems", "problem")
    mkdirSync(target, { recursive: true })
    writeFileSync(
      path.join(target, "ownership.json"),
      JSON.stringify({
        version: 1,
        problemID: "problem",
        directory,
        ownerProjectID: "project",
        ownerDirectory: root,
        orchestratorSessionID: "ses_parent",
      }),
    )
    symlinkSync(outside, path.join(root, ".math"))
    expect(() => inspectMathWorkspace(directory)).toThrow("symbolic link")
  })

  test("inspection rejects a symlinked problem directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "math-workspace-"))
    const outside = mkdtempSync(path.join(tmpdir(), "math-outside-"))
    roots.push(root, outside)
    const directory = path.join(root, ".math", "problems", "problem")
    mkdirSync(path.dirname(directory), { recursive: true })
    writeFileSync(
      path.join(outside, "ownership.json"),
      JSON.stringify({
        version: 1,
        problemID: "problem",
        directory,
        ownerProjectID: "project",
        ownerDirectory: root,
        orchestratorSessionID: "ses_parent",
      }),
    )
    symlinkSync(outside, directory)
    expect(() => inspectMathWorkspace(directory)).toThrow("symbolic link")
  })
})
