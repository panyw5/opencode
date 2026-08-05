import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_CREATE from "./project_task_create.txt"
import DESCRIPTION_LIST from "./project_task_list.txt"
import DESCRIPTION_MOUNT from "./project_task_mount.txt"
import DESCRIPTION_GET from "./project_task_get.txt"
import { ProjectTask } from "@/project-task/service"
import { ProjectTaskID, Status } from "@/project-task/schema"

const CreateParams = Schema.Struct({
  title: Schema.String.annotate({ description: "Short project task title" }),
  description: Schema.optional(Schema.String).annotate({
    description: "Longer description / acceptance notes",
  }),
  status: Schema.optional(Status).annotate({
    description: "Initial status: open, in_progress, done, or archived",
  }),
  priority: Schema.optional(Schema.String).annotate({ description: "Optional priority label" }),
})

const ListParams = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean).annotate({
    description: "Include archived tasks (default false)",
  }),
})

const MountParams = Schema.Struct({
  taskID: Schema.optional(Schema.String).annotate({
    description: "Project task ID to mount. Empty/omitted with unmount=true clears the mount.",
  }),
  unmount: Schema.optional(Schema.Boolean).annotate({
    description: "If true, unmount any project task from this session",
  }),
})

const GetParams = Schema.Struct({
  taskID: Schema.String.annotate({ description: "Project task ID to load" }),
})

export const ProjectTaskCreateTool = Tool.define<typeof CreateParams, { task: unknown }, ProjectTask.Service>(
  "project_task_create",
  Effect.gen(function* () {
    const tasks = yield* ProjectTask.Service
    return {
      description: DESCRIPTION_CREATE,
      parameters: CreateParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "project_task_create",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const task = yield* tasks.create({
            title: params.title,
            description: params.description,
            status: params.status,
            priority: params.priority,
          })
          return {
            title: `Created project task: ${task.title}`,
            output: JSON.stringify(task, null, 2),
            metadata: { task },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof CreateParams, { task: unknown }>
  }),
)

export const ProjectTaskListTool = Tool.define<typeof ListParams, { count: number }, ProjectTask.Service>(
  "project_task_list",
  Effect.gen(function* () {
    const tasks = yield* ProjectTask.Service
    return {
      description: DESCRIPTION_LIST,
      parameters: ListParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "project_task_list",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const list = yield* tasks.list({ includeArchived: params.includeArchived })
          return {
            title: `${list.length} project tasks`,
            output: JSON.stringify(list, null, 2),
            metadata: { count: list.length },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof ListParams, { count: number }>
  }),
)

export const ProjectTaskMountTool = Tool.define<typeof MountParams, { taskID: string | null }, ProjectTask.Service>(
  "project_task_mount",
  Effect.gen(function* () {
    const tasks = yield* ProjectTask.Service
    return {
      description: DESCRIPTION_MOUNT,
      parameters: MountParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "project_task_mount",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const unmount = params.unmount === true || !params.taskID?.trim()
          const taskID = unmount ? null : ProjectTaskID.make(params.taskID!.trim())
          const result = yield* tasks.mount({ sessionID: ctx.sessionID, taskID })
          return {
            title: unmount ? "Unmounted project task" : `Mounted project task: ${result?.title ?? taskID}`,
            output: JSON.stringify({ taskID, task: result }, null, 2),
            metadata: { taskID },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof MountParams, { taskID: string | null }>
  }),
)

export const ProjectTaskGetTool = Tool.define<typeof GetParams, { taskID: string }, ProjectTask.Service>(
  "project_task_get",
  Effect.gen(function* () {
    const tasks = yield* ProjectTask.Service
    return {
      description: DESCRIPTION_GET,
      parameters: GetParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "project_task_get",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const taskID = ProjectTaskID.make(params.taskID.trim())
          const detail = yield* tasks.detail(taskID)
          return {
            title: `Project task: ${detail.title}`,
            output: JSON.stringify(detail, null, 2),
            metadata: { taskID },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof GetParams, { taskID: string }>
  }),
)
