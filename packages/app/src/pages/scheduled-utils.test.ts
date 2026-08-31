import { describe, expect, test } from "bun:test"
import { filterActiveProjects, filterTasksForActiveProjects } from "./scheduled-utils"

describe("scheduled project filtering", () => {
  const open = { id: "open", worktree: "/workspace/open" }
  const closed = { id: "closed", worktree: "/workspace/closed" }

  test("only includes projects that are still open", () => {
    expect(filterActiveProjects([open, closed], [{ worktree: "/workspace/open/" }])).toEqual([open])
  })

  test("hides tasks belonging to closed projects", () => {
    const openTask = { id: "task-open", projectID: open.id }
    const closedTask = { id: "task-closed", projectID: closed.id }
    expect(filterTasksForActiveProjects([openTask, closedTask], [open])).toEqual([openTask])
  })
})
