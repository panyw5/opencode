import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import * as Tool from "./tool"
import DESCRIPTION from "./present_task.txt"
import { ProjectTask } from "@/project-task/service"
import { ProjectTaskID, type Detail, type Progress, type Status } from "@/project-task/schema"
import { ScheduledTaskRepository } from "@/scheduled-task/repository"
import { ScheduledTaskID, type Info as ScheduledTaskInfo, type Schedule } from "@/scheduled-task/schema"

/**
 * Payload the chat card renders. Deliberately denormalised and plain JSON: the
 * UI must not need a second round-trip, and this travels inside persisted tool
 * part metadata.
 */
export type PresentedProjectTask = {
  kind: "project_task"
  id: string
  title: string
  status: Status
  progress: Progress
  sessionCount: number
  descriptionPath: string
  /** Head of `.project-tasks/<id>/prd.md`; absent when the file is empty. */
  prdExcerpt?: string
  time: { created: number; updated: number; archived?: number }
}

export type PresentedScheduledTask = {
  kind: "scheduled_task"
  id: string
  title: string
  /** `disabled`, the last run status, or `pending` when it never ran. */
  status: string
  schedule: Schedule
  enabled: boolean
  nextRunAt?: number
  lastRunAt?: number
  lastStatus?: ScheduledTaskInfo["lastStatus"]
  agent: string
  model: ScheduledTaskInfo["model"]
  /** Head of the prompt the task runs. */
  promptExcerpt?: string
  time: { created: number; updated: number }
}

export type PresentedTask = PresentedProjectTask | PresentedScheduledTask

export const Parameters = Schema.Struct({
  taskID: Schema.String.annotate({
    description: "Exact project task ID (ptask_...) or scheduled task ID (task_...) to present",
  }),
})

const EXCERPT_CHARS = 1200
const TITLE_CHARS = 200
const PROJECT_TASK_PREFIX = "ptask_"

const log = Log.create({ service: "tool.present_task" })

function clip(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined
  const trimmed = text.trim()
  const chars = Array.from(trimmed)
  if (!chars.length) return undefined
  if (chars.length <= max) return trimmed
  return `${chars.slice(0, max).join("").trimEnd()}…`
}

function progressText(progress: Progress) {
  return `${progress.completed + progress.cancelled}/${progress.total} done`
}

function describeSchedule(schedule: Schedule) {
  if (schedule.kind === "cron") return `${schedule.expression}${schedule.timezone ? ` (${schedule.timezone})` : ""}`
  if (schedule.kind === "every") return `every ${Math.round(schedule.interval / 60_000)} min`
  return `at ${new Date(schedule.at).toISOString()}`
}

function digest(lines: (string | undefined)[]) {
  return lines.filter((line): line is string => !!line).join("\n")
}

export function projectTaskPayload(detail: Detail): PresentedProjectTask {
  return {
    kind: "project_task",
    id: detail.id,
    title: clip(detail.title, TITLE_CHARS) ?? detail.id,
    status: detail.status,
    progress: detail.progress,
    sessionCount: detail.sessionCount,
    descriptionPath: detail.descriptionPath,
    prdExcerpt: clip(detail.description, EXCERPT_CHARS),
    time: detail.time,
  }
}

export function scheduledTaskPayload(task: ScheduledTaskInfo): PresentedScheduledTask {
  return {
    kind: "scheduled_task",
    id: task.id,
    title: clip(task.name, TITLE_CHARS) ?? task.id,
    status: task.enabled ? (task.lastStatus ?? "pending") : "disabled",
    schedule: task.schedule,
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastStatus: task.lastStatus,
    agent: task.agent,
    model: task.model,
    promptExcerpt: clip(task.prompt, EXCERPT_CHARS),
    time: { created: task.time.created, updated: task.time.updated },
  }
}

export const PresentTaskTool = Tool.define<typeof Parameters, { presentedTask?: PresentedTask }, ProjectTask.Service>(
  "present_task",
  Effect.gen(function* () {
    const tasks = yield* ProjectTask.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const taskID = params.taskID.trim()
          if (!taskID) return yield* Effect.die(new Error("present_task requires a nonempty taskID"))
          if (taskID.startsWith(PROJECT_TASK_PREFIX)) {
            yield* ctx.ask({
              permission: "project_task_get",
              patterns: [taskID],
              always: ["*"],
              metadata: { taskID },
            })
            const detail = yield* tasks.detail(ProjectTaskID.make(taskID)).pipe(
              Effect.mapError(() => new Error(`No project task found with taskID ${taskID}`)),
              Effect.orDie,
            )
            const presented = projectTaskPayload(detail)
            log.info("project task presented", { sessionID: ctx.sessionID, taskID: presented.id })
            return {
              title: presented.title,
              output: digest([
                `Presented project task ${presented.id}: ${presented.title}`,
                `Status: ${presented.status}`,
                `Progress: ${progressText(presented.progress)}${
                  presented.progress.inProgress ? ` (${presented.progress.inProgress} in progress)` : ""
                }`,
                `Sessions: ${presented.sessionCount}`,
                `PRD: ${presented.descriptionPath}`,
              ]),
              metadata: { presentedTask: presented },
            }
          }
          yield* ctx.ask({
            permission: "scheduled_task_get",
            patterns: [taskID],
            always: ["*"],
            metadata: { taskID },
          })
          const found = yield* ScheduledTaskRepository.get(ScheduledTaskID.make(taskID)).pipe(Effect.orDie)
          if (!found) return yield* Effect.die(new Error(`No scheduled task found with taskID ${taskID}`))
          const presented = scheduledTaskPayload(found)
          log.info("scheduled task presented", { sessionID: ctx.sessionID, taskID: presented.id })
          return {
            title: presented.title,
            output: digest([
              `Presented scheduled task ${presented.id}: ${presented.title}`,
              `Status: ${presented.status}`,
              `Schedule: ${describeSchedule(presented.schedule)}`,
              presented.nextRunAt ? `Next run: ${new Date(presented.nextRunAt).toISOString()}` : undefined,
              `Agent: ${presented.agent} · ${presented.model.providerID}/${presented.model.modelID}`,
            ]),
            metadata: { presentedTask: presented },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, { presentedTask?: PresentedTask }>
  }),
)
