import { describe, expect, test } from "bun:test"
import { projectTaskPayload, scheduledTaskPayload } from "../../src/tool/present_task"
import type { Detail } from "../../src/project-task/schema"
import type { Info as ScheduledTaskInfo } from "../../src/scheduled-task/schema"

function projectTask(overrides: Partial<Detail> = {}): Detail {
  return {
    id: "ptask_0000000000000test",
    projectID: "prj_test",
    title: "Ship present_task card",
    description: "  Acceptance notes  ",
    descriptionPath: ".project-tasks/ptask_0000000000000test/prd.md",
    status: "in_progress",
    sessionCount: 2,
    progress: { total: 7, completed: 3, inProgress: 1, pending: 3, cancelled: 0 },
    sessionDirectories: [],
    time: { created: 1, updated: 2 },
    sessions: [],
    ...overrides,
  } as Detail
}

function scheduledTask(overrides: Partial<ScheduledTaskInfo> = {}): ScheduledTaskInfo {
  return {
    id: "task_0000000000000test",
    projectID: "prj_test",
    directory: "/tmp/project",
    name: "Nightly triage",
    prompt: "Summarise yesterday's crashes.",
    schedule: { kind: "cron", expression: "0 3 * * *" },
    executionMode: "automatic_session",
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
    enabled: true,
    unattended: true,
    time: { created: 1, updated: 2 },
    ...overrides,
  } as ScheduledTaskInfo
}

describe("present_task", () => {
  test("projects a project task into card payload", () => {
    const payload = projectTaskPayload(projectTask())
    expect(payload).toMatchObject({
      kind: "project_task",
      id: "ptask_0000000000000test",
      title: "Ship present_task card",
      status: "in_progress",
      progress: { total: 7, completed: 3 },
      sessionCount: 2,
      prdExcerpt: "Acceptance notes",
    })
  })

  test("drops an empty prd excerpt", () => {
    const payload = projectTaskPayload(projectTask({ description: "   \n" }))
    expect(payload.prdExcerpt).toBeUndefined()
  })

  test("clips the prd excerpt to 1200 characters", () => {
    const payload = projectTaskPayload(projectTask({ description: "字".repeat(1500) }))
    const excerpt = payload.prdExcerpt!
    expect(Array.from(excerpt)).toHaveLength(1201)
    expect(excerpt.endsWith("…")).toBe(true)
  })

  test("derives scheduled status from enabled and last run", () => {
    expect(scheduledTaskPayload(scheduledTask()).status).toBe("pending")
    expect(scheduledTaskPayload(scheduledTask({ lastStatus: "ok" })).status).toBe("ok")
    expect(scheduledTaskPayload(scheduledTask({ enabled: false, lastStatus: "error" })).status).toBe("disabled")
  })

  test("keeps schedule, model and prompt excerpt for scheduled tasks", () => {
    const payload = scheduledTaskPayload(scheduledTask({ prompt: "p".repeat(1300), nextRunAt: 1234 }))
    expect(payload).toMatchObject({
      kind: "scheduled_task",
      title: "Nightly triage",
      schedule: { kind: "cron", expression: "0 3 * * *" },
      enabled: true,
      nextRunAt: 1234,
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
    })
    if (payload.kind !== "scheduled_task") throw new Error("expected scheduled payload")
    expect(Array.from(payload.promptExcerpt!)).toHaveLength(1201)
  })
})
