import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mathProblemsRoot, mathRoot } from "@/math/layout"

describe("math.layout", () => {
  test("isolates every problem below the workspace math container", () => {
    const workspace = path.join(path.sep, "tmp", "research")
    const first = mathRoot(workspace, "problem-a")
    const second = mathRoot(workspace, "problem-b")

    expect(mathProblemsRoot(workspace)).toBe(path.join(workspace, ".math", "problems"))
    expect(first).toBe(path.join(workspace, ".math", "problems", "problem-a"))
    expect(second).toBe(path.join(workspace, ".math", "problems", "problem-b"))
    expect(first).not.toBe(second)
  })

  test("rejects paths that could escape a problem workspace", () => {
    expect(() => mathRoot("/tmp/research", "../other-problem")).toThrow("invalid project name")
    expect(() => mathRoot("/tmp/research", "problem/child")).toThrow("invalid project name")
  })
})
