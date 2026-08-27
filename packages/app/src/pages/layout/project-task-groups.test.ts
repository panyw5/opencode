import { describe, expect, test } from "bun:test"
import {
  directoriesFromSessions,
  groupProjectTasksByWorktree,
  matchWorktreeRoot,
  taskNeedsDirectoryHydrate,
} from "./project-task-groups"

const task = (id: string, directories: string[] = []) => ({
  id,
  sessionDirectories: directories,
})

test("hydrates unique session directories from detail sessions", () => {
  expect(taskNeedsDirectoryHydrate({})).toBe(true)
  expect(taskNeedsDirectoryHydrate({ sessionDirectories: undefined })).toBe(true)
  expect(taskNeedsDirectoryHydrate({ sessionDirectories: [] })).toBe(false)
  expect(
    directoriesFromSessions([
      { directory: "/Users/lelouch/apps/opencode" },
      { directory: "/Users/lelouch/apps/worktrees/opencode-math-mode" },
      { directory: "/Users/lelouch/apps/worktrees/opencode-math-mode/" },
      { directory: "  " },
    ]),
  ).toEqual(["/Users/lelouch/apps/opencode", "/Users/lelouch/apps/worktrees/opencode-math-mode"])
})

describe("matchWorktreeRoot", () => {
  test("matches exact worktree and sandbox paths", () => {
    const worktrees = ["/repo", "/repo-wt"]
    expect(matchWorktreeRoot("/repo", worktrees)).toBe("/repo")
    expect(matchWorktreeRoot("/repo-wt", worktrees)).toBe("/repo-wt")
  })

  test("maps subdirectory sessions onto the longest worktree root", () => {
    const worktrees = ["/repo", "/repo/packages"]
    expect(matchWorktreeRoot("/repo/packages/app", worktrees)).toBe("/repo/packages")
    expect(matchWorktreeRoot("/repo/src", worktrees)).toBe("/repo")
  })

  test("does not treat a similarly prefixed path as the same worktree", () => {
    expect(matchWorktreeRoot("/repo-wt", ["/repo"])).toBeUndefined()
  })
})

describe("groupProjectTasksByWorktree", () => {
  test("keeps a single worktree as one block including unmounted tasks", () => {
    const groups = groupProjectTasksByWorktree({
      tasks: [task("a"), task("b", ["/repo"])],
      worktrees: ["/repo"],
    })
    expect(groups).toEqual([
      {
        directory: "/repo",
        tasks: [task("a"), task("b", ["/repo"])],
      },
    ])
  })

  test("splits tasks across main and sandbox worktrees", () => {
    const unmounted = task("main-only")
    const sandbox = task("wt", ["/repo-wt"])
    const both = task("shared", ["/repo", "/repo-wt"])
    const groups = groupProjectTasksByWorktree({
      tasks: [unmounted, sandbox, both],
      worktrees: ["/repo", "/repo-wt"],
    })
    expect(groups.map((group) => group.directory)).toEqual(["/repo", "/repo-wt"])
    expect(groups[0]?.tasks.map((item) => item.id)).toEqual(["main-only", "shared"])
    expect(groups[1]?.tasks.map((item) => item.id)).toEqual(["wt", "shared"])
  })

  test("keeps empty known worktrees so the panel can render every block", () => {
    const groups = groupProjectTasksByWorktree({
      tasks: [task("a", ["/repo"])],
      worktrees: ["/repo", "/repo-wt"],
    })
    expect(groups[1]).toEqual({ directory: "/repo-wt", tasks: [] })
  })

  test("places math-mode sandbox sessions in the math-mode worktree block", () => {
    const main = "/Users/lelouch/apps/opencode"
    const mathMode = "/Users/lelouch/apps/worktrees/opencode-math-mode"
    const groups = groupProjectTasksByWorktree({
      tasks: [task("math", [main, mathMode]), task("main-only", [main])],
      worktrees: [main, "/Users/lelouch/apps/trellis-worktrees/port-subagent-features", mathMode],
    })
    expect(groups.find((group) => group.directory === mathMode)?.tasks.map((item) => item.id)).toEqual(["math"])
    expect(groups.find((group) => group.directory === main)?.tasks.map((item) => item.id)).toEqual(["math", "main-only"])
  })

  test("appends unknown session directories as extra blocks", () => {
    const groups = groupProjectTasksByWorktree({
      tasks: [task("other", ["/elsewhere"])],
      worktrees: ["/repo"],
    })
    expect(groups.map((group) => group.directory)).toEqual(["/repo", "/elsewhere"])
    expect(groups[1]?.tasks.map((item) => item.id)).toEqual(["other"])
  })
})
