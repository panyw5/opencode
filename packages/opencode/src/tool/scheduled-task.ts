import { InstanceState } from "@/effect/instance-state"
import { ScheduledTaskCreate } from "@/scheduled-task/create"
import type { Info } from "@/scheduled-task/schema"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import DESCRIPTION from "./scheduled_task_create.txt"
import * as Tool from "./tool"

const log = Log.create({ service: "tool.scheduled-task" })

const Text = Schema.Trim.check(Schema.isNonEmpty())

const Schedule = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("at"),
    at: NonNegativeInt.annotate({ description: "Unix timestamp in milliseconds for a one-time run" }),
  }),
  Schema.Struct({
    kind: Schema.Literal("every"),
    interval: PositiveInt.annotate({ description: "Positive recurrence interval in milliseconds" }),
  }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: Text.annotate({ description: "Five-field cron expression, for example 0 9 * * 1-5" }),
    timezone: Schema.optional(Text).annotate({
      description: "Optional IANA timezone, for example Asia/Shanghai. Defaults to the server timezone.",
    }),
  }),
]).annotate({ description: "When the scheduled task should run" })

export const Parameters = Schema.Struct({
  name: Text.annotate({ description: "Short name shown in the scheduled tasks UI" }),
  prompt: Text.annotate({ description: "Prompt the agent should execute when the task runs" }),
  schedule: Schedule,
  executionMode: Schema.optional(Schema.Literals(["existing_session", "new_session"])).annotate({
    description:
      "existing_session continues this session on every run (default); new_session creates a separate session for each run",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the task should start enabled. Defaults to true.",
  }),
})

type Metadata = {
  task: Info
}

function model(ctx: Tool.Context) {
  const user = ctx.messages.findLast((message) => message.info.role === "user")
  if (!user || user.info.role !== "user") throw new Error("Scheduled task creation requires a user message")
  return user.info.model
}

export const ScheduledTaskCreateTool = Tool.define<typeof Parameters, Metadata, never>(
  "scheduled_task_create",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        log.info("scheduled task tool requested", {
          sessionID: ctx.sessionID,
          agent: ctx.agent,
          name: params.name,
          scheduleKind: params.schedule.kind,
          executionMode: params.executionMode ?? "existing_session",
        })
        yield* ctx.ask({
          permission: "scheduled_task_create",
          patterns: [params.name],
          always: ["*"],
          metadata: {
            name: params.name,
            schedule: params.schedule,
            executionMode: params.executionMode ?? "existing_session",
          },
        })
        log.info("scheduled task tool permission granted", { sessionID: ctx.sessionID, name: params.name })

        const instance = yield* InstanceState.context
        const selectedModel = model(ctx)
        const executionMode = params.executionMode ?? "existing_session"
        log.info("scheduled task tool context resolved", {
          sessionID: ctx.sessionID,
          projectID: instance.project.id,
          directory: instance.directory,
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        })

        const task = yield* ScheduledTaskCreate.create({
          projectID: instance.project.id,
          projectName: instance.project.name,
          directory: instance.directory,
          name: params.name,
          prompt: params.prompt,
          schedule: params.schedule,
          executionMode,
          sessionID: executionMode === "existing_session" ? ctx.sessionID : undefined,
          agent: ctx.agent,
          model: selectedModel,
          enabled: params.enabled,
          unattended: true,
        })
        log.info("scheduled task tool completed", { sessionID: ctx.sessionID, taskID: task.id })

        return {
          title: `Created scheduled task: ${task.name}`,
          output: JSON.stringify(task, null, 2),
          metadata: { task },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>),
)
