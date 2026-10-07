import { describe, expect, test } from "bun:test"
import {
  formatPresentedTaskDate,
  formatPresentedTaskSchedule,
  presentedTaskProgressPercent,
  presentedTaskStatusLabel,
  presentedTaskTone,
  readPresentedTask,
  type PresentedProjectTask,
  type PresentedScheduledTask,
  type PresentedTask,
} from "./task-card"

const projectTask: PresentedProjectTask = {
  kind: "project_task",
  id: "ptask_1",
  title: "Ship the card",
  status: "in_progress",
  progress: { total: 4, completed: 2, inProgress: 1, pending: 1, cancelled: 0 },
  sessionCount: 2,
  descriptionPath: ".project-tasks/ptask_1/prd.md",
  prdExcerpt: "acceptance notes",
  time: { created: 10, updated: 20 },
}

const scheduledTask: PresentedScheduledTask = {
  kind: "scheduled_task",
  id: "task_1",
  title: "Nightly triage",
  status: "ok",
  schedule: { kind: "cron", expression: "0 3 * * *", timezone: "Asia/Shanghai" },
  enabled: true,
  nextRunAt: 1_800_000_000_000,
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
  promptExcerpt: "Summarise crashes.",
  time: { created: 10, updated: 20 },
}

const translate = (key: string, params?: Record<string, string | number>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

describe("presented task card", () => {
  test("reads a project task payload from part metadata", () => {
    expect<PresentedTask | undefined>(readPresentedTask({ presentedTask: projectTask })).toEqual(projectTask)
  })

  test("reads a scheduled task payload and keeps optional fields absent", () => {
    const value = readPresentedTask({ presentedTask: scheduledTask })!
    expect(value.kind).toBe("scheduled_task")
    if (value.kind !== "scheduled_task") throw new Error(`unexpected kind ${value.kind}`)
    expect(value.lastRunAt).toBeUndefined()
  })

  test("ignores missing, malformed, or unknown-kind payloads so the generic row renders", () => {
    expect(readPresentedTask(undefined)).toBeUndefined()
    expect(readPresentedTask({})).toBeUndefined()
    expect(readPresentedTask({ presentedTask: { id: "ptask_1" } })).toBeUndefined()
    expect(readPresentedTask({ presentedTask: { ...projectTask, id: "" } })).toBeUndefined()
    expect(readPresentedTask({ presentedTask: { ...scheduledTask, schedule: undefined } })).toBeUndefined()
    expect(readPresentedTask({ presentedTask: { ...projectTask, status: "unknown" } })).toBeUndefined()
  })

  test("falls back to the task ID when the title is blank", () => {
    expect(readPresentedTask({ presentedTask: { ...projectTask, title: "   " } })!.title).toBe("ptask_1")
  })

  test("maps status to card tone", () => {
    const project = readPresentedTask({ presentedTask: projectTask }) as PresentedProjectTask
    expect(presentedTaskTone(project)).toBe("active")
    expect(presentedTaskTone({ ...project, status: "done" })).toBe("success")
    expect(presentedTaskTone({ ...project, status: "archived" })).toBe("muted")
    expect(presentedTaskTone({ ...project, status: "open" })).toBe("neutral")
    expect(presentedTaskTone(readPresentedTask({ presentedTask: scheduledTask }))).toBe("success")
    expect(presentedTaskTone(readPresentedTask({ presentedTask: { ...scheduledTask, status: "error" } }))).toBe(
      "danger",
    )
    expect(presentedTaskTone(readPresentedTask({ presentedTask: { ...scheduledTask, status: "disabled" } }))).toBe(
      "muted",
    )
    expect(presentedTaskTone(undefined)).toBe("neutral")
  })

  test("counts cancelled items as finished progress and guards against empty totals", () => {
    expect(presentedTaskProgressPercent({ total: 4, completed: 2, inProgress: 0, pending: 0, cancelled: 2 })).toBe(100)
    expect(presentedTaskProgressPercent({ total: 0, completed: 0, inProgress: 0, pending: 0, cancelled: 0 })).toBe(0)
  })

  test("formats schedule kinds", () => {
    expect(formatPresentedTaskSchedule({ kind: "every", interval: 120_000 }, translate)).toBe(
      'ui.presentedTask.schedule.every:{"count":2}',
    )
    expect(formatPresentedTaskSchedule({ kind: "at", at: 1_800_000_000_000 }, translate)).toBe(
      "ui.presentedTask.schedule.at",
    )
    expect(
      formatPresentedTaskSchedule({ kind: "cron", expression: "0 3 * * *", timezone: "Asia/Shanghai" }, translate),
    ).toBe("0 3 * * * · Asia/Shanghai")
  })

  test("labels project status and keeps unknown scheduled status verbatim", () => {
    const project = readPresentedTask({ presentedTask: projectTask }) as PresentedProjectTask
    expect(presentedTaskStatusLabel(project, translate)).toBe("ui.presentedTask.status.inProgress")
    expect(presentedTaskStatusLabel({ ...project, status: "done" }, translate)).toBe("ui.presentedTask.status.done")
    const scheduled = readPresentedTask({ presentedTask: scheduledTask })!
    expect(presentedTaskStatusLabel(scheduled, translate)).toBe("ui.presentedTask.status.ok")
  })

  test("formats timestamps for the active locale and skips missing ones", () => {
    expect(formatPresentedTaskDate(undefined, "en-US")).toBeUndefined()
    expect(formatPresentedTaskDate(1_800_000_000_000, "en-US")).toMatch(/2027/)
  })
})
