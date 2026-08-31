import { describe, expect, test } from "bun:test"
import { sameScheduledTaskPanelScope, scheduledTaskEventMatchesScope } from "./scheduled-tasks-panel-scope"

describe("scheduled task panel scope", () => {
  test("remains stable when the project object updates without changing scope strings", () => {
    expect(
      sameScheduledTaskPanelScope(
        { projectID: "project", directory: "/Users/example/chat" },
        { projectID: "project", directory: "/Users/example/chat" },
      ),
    ).toBe(true)
    expect(
      sameScheduledTaskPanelScope(
        { projectID: "project", directory: "/Users/example/chat" },
        { projectID: "project", directory: "/Users/example/other" },
      ),
    ).toBe(false)
  })

  test("refreshes only for scheduled task events from the active directory", () => {
    const scope = { projectID: "project", directory: "/Users/example/chat" }
    expect(scheduledTaskEventMatchesScope("/Users/example/chat/", scope)).toBe(true)
    expect(scheduledTaskEventMatchesScope("/Users/example/other", scope)).toBe(false)
  })
})
