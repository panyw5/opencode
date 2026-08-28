import { InstanceState } from "@/effect/instance-state"
import { ScheduledTaskCreate } from "@/scheduled-task/create"
import { ScheduledTaskMutate } from "@/scheduled-task/mutate"
import { ScheduledTaskRepository } from "@/scheduled-task/repository"
import { ScheduledTaskID, type Info, type Run } from "@/scheduled-task/schema"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Option, Schema } from "effect"
import DESCRIPTION from "./scheduled_task_create.txt"
import DESCRIPTION_LIST from "./scheduled_task_list.txt"
import DESCRIPTION_GET from "./scheduled_task_get.txt"
import DESCRIPTION_UPDATE from "./scheduled_task_update.txt"
import DESCRIPTION_DELETE from "./scheduled_task_delete.txt"
import DESCRIPTION_RUN_NOW from "./scheduled_task_run_now.txt"
import DESCRIPTION_RUNS from "./scheduled_task_runs.txt"
import * as Tool from "./tool"

const log = Log.create({ service: "tool.scheduled-task" })

// The scheduler execution service is resolved lazily. Statically importing it
// here would form a cycle (service -> session/prompt -> tool/registry -> this
// file), so we load it only when a run-now / runs tool actually executes.
const scheduledTaskService = () =>
  Effect.promise(() => import("@/scheduled-task/service")).pipe(
    Effect.flatMap((mod) => Effect.serviceOption(mod.ScheduledTask.Service)),
  )

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

const Model = Schema.Struct({
  providerID: Text.annotate({ description: "Provider ID, for example anthropic or openai" }),
  modelID: Text.annotate({ description: "Model ID exposed by the provider" }),
  variant: Schema.optional(Text).annotate({
    description: "Optional model variant controlling reasoning or thinking intensity, for example low, medium, or high",
  }),
}).annotate({ description: "Model and optional reasoning or thinking intensity used when the task runs" })

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

const ListParameters = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Only list tasks in this enabled state. Defaults to both.",
  }),
})

export const ScheduledTaskListTool = Tool.define<typeof ListParameters, { count: number }, never>(
  "scheduled_task_list",
  Effect.succeed({
    description: DESCRIPTION_LIST,
    parameters: ListParameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        log.info("scheduled task list requested", { sessionID: ctx.sessionID, agent: ctx.agent })
        yield* ctx.ask({
          permission: "scheduled_task_list",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })
        const instance = yield* InstanceState.context
        const list = yield* ScheduledTaskRepository.list({
          projectID: instance.project.id,
          enabled: params.enabled,
        })
        log.info("scheduled task list completed", { sessionID: ctx.sessionID, count: list.length })
        return {
          title: `${list.length} scheduled tasks`,
          output: JSON.stringify(list, null, 2),
          metadata: { count: list.length },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof ListParameters, { count: number }>),
)

const GetParameters = Schema.Struct({
  taskID: Text.annotate({ description: "ID of the scheduled task to fetch" }),
})

const notFoundOutput = <M extends Record<string, unknown>>(taskID: string, metadata: M) => ({
  title: "Scheduled task not found",
  output: JSON.stringify({ error: `No scheduled task found with taskID ${taskID}` }, null, 2),
  metadata,
})

export const ScheduledTaskGetTool = Tool.define<typeof GetParameters, { task: Info | null }, never>(
  "scheduled_task_get",
  Effect.succeed({
    description: DESCRIPTION_GET,
    parameters: GetParameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        log.info("scheduled task get requested", { sessionID: ctx.sessionID, taskID: params.taskID })
        yield* ctx.ask({
          permission: "scheduled_task_get",
          patterns: [params.taskID],
          always: ["*"],
          metadata: { taskID: params.taskID },
        })
        const taskID = ScheduledTaskID.make(params.taskID)
        const task = yield* ScheduledTaskRepository.get(taskID)
        if (!task) return notFoundOutput(params.taskID, { task: null })
        log.info("scheduled task get completed", { sessionID: ctx.sessionID, taskID: task.id })
        return {
          title: `Scheduled task: ${task.name}`,
          output: JSON.stringify(task, null, 2),
          metadata: { task },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof GetParameters, { task: Info | null }>),
)

const UpdateParameters = Schema.Struct({
  taskID: Text.annotate({ description: "ID of the existing scheduled task to update" }),
  name: Schema.optional(Text).annotate({ description: "New short name shown in the scheduled tasks UI" }),
  prompt: Schema.optional(Text).annotate({
    description: "New prompt the agent should execute when the task runs",
  }),
  schedule: Schema.optional(Schedule),
  executionMode: Schema.optional(Schema.Literals(["existing_session", "new_session"])).annotate({
    description:
      "existing_session continues this session on every run (default); new_session creates a separate session for each run",
  }),
  model: Schema.optional(Model).annotate({
    description: "New model and optional reasoning or thinking intensity used when the task runs",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the task should be enabled. Disabled tasks do not fire until re-enabled.",
  }),
})

export const ScheduledTaskUpdateTool = Tool.define<typeof UpdateParameters, { task: Info | null }, never>(
  "scheduled_task_update",
  Effect.succeed({
    description: DESCRIPTION_UPDATE,
    parameters: UpdateParameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        log.info("scheduled task update requested", {
          sessionID: ctx.sessionID,
          taskID: params.taskID,
          name: params.name,
          scheduleKind: params.schedule?.kind,
          executionMode: params.executionMode,
          modelProviderID: params.model?.providerID,
          modelID: params.model?.modelID,
          modelVariant: params.model?.variant,
        })
        yield* ctx.ask({
          permission: "scheduled_task_update",
          patterns: [params.taskID],
          always: ["*"],
          metadata: {
            taskID: params.taskID,
            name: params.name,
            schedule: params.schedule,
            executionMode: params.executionMode,
            model: params.model,
            enabled: params.enabled,
          },
        })
        const taskID = ScheduledTaskID.make(params.taskID)
        if (
          params.name === undefined &&
          params.prompt === undefined &&
          params.schedule === undefined &&
          params.executionMode === undefined &&
          params.model === undefined &&
          params.enabled === undefined
        ) {
          return {
            title: "No scheduled task fields to update",
            output: JSON.stringify(
              { error: "Provide at least one of name, prompt, schedule, executionMode, model, enabled" },
              null,
              2,
            ),
            metadata: { task: null },
          }
        }
        const existing = yield* ScheduledTaskRepository.get(taskID)
        if (!existing) return notFoundOutput(params.taskID, { task: null })
        const sessionID =
          params.executionMode === "existing_session"
            ? ctx.sessionID
            : params.executionMode === "new_session"
              ? null
              : undefined
        log.info("scheduled task update resolved", {
          sessionID: ctx.sessionID,
          taskID,
          previousExecutionMode: existing.executionMode,
          nextExecutionMode: params.executionMode,
          boundSessionID: sessionID,
          previousModelProviderID: existing.model.providerID,
          previousModelID: existing.model.modelID,
          nextModelProviderID: params.model?.providerID,
          nextModelID: params.model?.modelID,
          nextModelVariant: params.model?.variant,
        })
        const task = yield* ScheduledTaskMutate.update(taskID, {
          name: params.name,
          prompt: params.prompt,
          schedule: params.schedule,
          executionMode: params.executionMode,
          sessionID,
          model: params.model,
          enabled: params.enabled,
        })
        log.info("scheduled task update completed", { sessionID: ctx.sessionID, taskID: task.id })
        return {
          title: `Updated scheduled task: ${task.name}`,
          output: JSON.stringify(task, null, 2),
          metadata: { task },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof UpdateParameters, { task: Info | null }>),
)

const DeleteParameters = Schema.Struct({
  taskID: Text.annotate({ description: "ID of the scheduled task to delete" }),
})

export const ScheduledTaskDeleteTool = Tool.define<typeof DeleteParameters, { taskID: string }, never>(
  "scheduled_task_delete",
  Effect.succeed({
    description: DESCRIPTION_DELETE,
    parameters: DeleteParameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        log.info("scheduled task delete requested", { sessionID: ctx.sessionID, taskID: params.taskID })
        yield* ctx.ask({
          permission: "scheduled_task_delete",
          patterns: [params.taskID],
          always: ["*"],
          metadata: { taskID: params.taskID },
        })
        const taskID = ScheduledTaskID.make(params.taskID)
        const existing = yield* ScheduledTaskRepository.get(taskID)
        if (!existing) return notFoundOutput(params.taskID, { taskID: params.taskID })
        yield* ScheduledTaskMutate.remove(taskID)
        log.info("scheduled task delete completed", { sessionID: ctx.sessionID, taskID })
        return {
          title: `Deleted scheduled task: ${existing.name}`,
          output: JSON.stringify({ taskID: existing.id, deleted: true }, null, 2),
          metadata: { taskID: existing.id },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof DeleteParameters, { taskID: string }>),
)

const RunNowParameters = Schema.Struct({
  taskID: Text.annotate({ description: "ID of the scheduled task to run immediately" }),
})

export const ScheduledTaskRunNowTool = Tool.define<typeof RunNowParameters, { run: Run | null }, never>(
  "scheduled_task_run_now",
  Effect.succeed({
    description: DESCRIPTION_RUN_NOW,
    parameters: RunNowParameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        log.info("scheduled task run-now requested", { sessionID: ctx.sessionID, taskID: params.taskID })
        yield* ctx.ask({
          permission: "scheduled_task_run_now",
          patterns: [params.taskID],
          always: ["*"],
          metadata: { taskID: params.taskID },
        })
        const taskID = ScheduledTaskID.make(params.taskID)
        const existing = yield* ScheduledTaskRepository.get(taskID)
        if (!existing) return notFoundOutput(params.taskID, { run: null })
        const scheduled = Option.getOrUndefined(yield* scheduledTaskService())
        if (!scheduled) {
          return {
            title: "Scheduled task runner unavailable",
            output: JSON.stringify(
              { error: "The scheduled task runner is not available in this environment" },
              null,
              2,
            ),
            metadata: { run: null },
          }
        }
        const run = yield* scheduled.runNow(taskID)
        log.info("scheduled task run-now completed", { sessionID: ctx.sessionID, taskID, runID: run.id })
        return {
          title: `Started scheduled task: ${existing.name}`,
          output: JSON.stringify(run, null, 2),
          metadata: { run },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof RunNowParameters, { run: Run | null }>),
)

const RunsParameters = Schema.Struct({
  taskID: Text.annotate({ description: "ID of the scheduled task whose runs to list" }),
  limit: Schema.optional(PositiveInt).annotate({
    description: "Maximum number of runs to return. Defaults to 100.",
  }),
})

export const ScheduledTaskRunsTool = Tool.define<typeof RunsParameters, { count: number }, never>(
  "scheduled_task_runs",
  Effect.succeed({
    description: DESCRIPTION_RUNS,
    parameters: RunsParameters,
    execute: (params, ctx) =>
      Effect.gen(function* () {
        log.info("scheduled task runs requested", { sessionID: ctx.sessionID, taskID: params.taskID })
        yield* ctx.ask({
          permission: "scheduled_task_runs",
          patterns: [params.taskID],
          always: ["*"],
          metadata: { taskID: params.taskID },
        })
        const taskID = ScheduledTaskID.make(params.taskID)
        const existing = yield* ScheduledTaskRepository.get(taskID)
        if (!existing) return notFoundOutput(params.taskID, { count: 0 })
        const scheduled = Option.getOrUndefined(yield* scheduledTaskService())
        if (!scheduled) {
          return {
            title: "Scheduled task runner unavailable",
            output: JSON.stringify(
              { error: "The scheduled task runner is not available in this environment" },
              null,
              2,
            ),
            metadata: { count: 0 },
          }
        }
        const runs = yield* scheduled.runs(taskID, params.limit)
        log.info("scheduled task runs completed", { sessionID: ctx.sessionID, taskID, count: runs.length })
        return {
          title: `${runs.length} runs for ${existing.name}`,
          output: JSON.stringify(runs, null, 2),
          metadata: { count: runs.length },
        }
      }).pipe(Effect.orDie),
  } satisfies Tool.DefWithoutID<typeof RunsParameters, { count: number }>),
)
