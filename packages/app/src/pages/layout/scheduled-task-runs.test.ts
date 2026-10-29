import { describe, expect, test } from "bun:test"
import type { ScheduledTaskRun } from "@opencode-ai/sdk/v2/client"
import { mergeScheduledTaskRuns } from "./scheduled-task-runs"

function run(id: string, scheduledAt: number, update: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  return { id, taskID: "task", scheduledAt, status: "running", attempt: 1, time: { created: scheduledAt }, ...update }
}

describe("scheduled task local run updates", () => {
  test("inserts new runs newest first, updates by ID, and caps the history", () => {
    const first = run("first", 1)
    const second = run("second", 2)
    const completed = run("second", 2, { status: "ok", sessionID: "session" })
    expect(mergeScheduledTaskRuns([second, first], [completed, run("third", 3)], 2)).toEqual([
      run("third", 3),
      completed,
    ])
    expect(second.status).toBe("running")
  })

  test("keeps live session/status updates when the initial snapshot arrives late", () => {
    const snapshot = [run("first", 1)]
    const live = [run("second", 2), run("first", 1, { status: "ok", sessionID: "session" })]
    expect(mergeScheduledTaskRuns(snapshot, live)).toEqual(live)
  })
})
