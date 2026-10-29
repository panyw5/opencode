import { expect, test } from "bun:test"
import type { ScheduledTaskRun } from "@opencode-ai/sdk/v2/client"
import { createStore, reconcile } from "solid-js/store"
import { mergeScheduledTaskRuns } from "../src/pages/layout/scheduled-task-runs"

test("local scheduled run updates preserve existing row identities in the browser build", () => {
  const run = (id: string, scheduledAt: number): ScheduledTaskRun => ({
    id,
    taskID: "task",
    scheduledAt,
    status: "running",
    attempt: 1,
    time: { created: scheduledAt },
  })
  const [state, setState] = createStore({ runs: [run("first", 1), run("older", 0)] })
  const first = state.runs[0]
  const older = state.runs[1]
  setState("runs", reconcile(mergeScheduledTaskRuns(state.runs, [run("second", 2)])))
  setState("runs", reconcile(mergeScheduledTaskRuns(state.runs, [{ ...run("first", 1), status: "ok" }])))
  expect(state.runs[1]).toBe(first)
  expect(state.runs[2]).toBe(older)
  expect(first.status).toBe("ok")
})
