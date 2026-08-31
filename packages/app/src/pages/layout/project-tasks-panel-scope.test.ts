import { describe, expect, test } from "bun:test"
import { projectTaskEventMatchesScope, sameProjectTaskPanelScope } from "./project-tasks-panel-scope"

describe("project task panel scope", () => {
  test("ignores object updates when project and directory strings are unchanged", () => {
    const scope = { projectID: "project", directory: "/workspace" }
    expect(sameProjectTaskPanelScope(scope, { ...scope })).toBe(true)
    expect(sameProjectTaskPanelScope(scope, { ...scope, projectID: "other" })).toBe(false)
  })

  test("matches events by project across worktrees and falls back to directory", () => {
    const scope = { projectID: "project", directory: "/workspace/main" }
    expect(projectTaskEventMatchesScope({ projectID: "project", directory: "/workspace/linked" }, scope)).toBe(true)
    expect(projectTaskEventMatchesScope({ projectID: "other", directory: "/workspace/main" }, scope)).toBe(false)
    expect(projectTaskEventMatchesScope({ directory: "/workspace/main/" }, scope)).toBe(true)
  })
})
