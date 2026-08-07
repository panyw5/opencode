import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_CREATE from "./project_task_create.txt"
import DESCRIPTION_LIST from "./project_task_list.txt"
import DESCRIPTION_MOUNT from "./project_task_mount.txt"
import DESCRIPTION_GET from "./project_task_get.txt"
import DESCRIPTION_UPDATE from "./project_task_update.txt"
import { ProjectTask } from "@/project-task/service"
import { ProjectTaskID, Status } from "@/project-task/schema"

/** Create may only start open or in_progress — done/archived require update. */
const CreateStatus = Schema.Literals(["open", "in_progress"]).annotate({
  description: "Initial status: open or in_progress only. Use project_task_update for done/archived.",
})

const CreateParams = Schema.Struct({
  title: Schema.String.annotate({ description: "Short project task title" }),
  description: Schema.optional(Schema.String).annotate({
    description:
      "Longer description / acceptance notes. Written to `.tasks/<taskID>/description.md` (see descriptionPath).",
  }),
  status: Schema.optional(CreateStatus).annotate({
    description: "Initial status: open (default) or in_progress. Never done/archived on create.",
  }),
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

const UpdateParams = Schema.Struct({
  taskID: Schema.String.annotate({ description: "Existing project task ID to update" }),
  title: Schema.optional(Schema.String).annotate({ description: "New title" }),
  description: Schema.optional(Schema.String).annotate({
    description: "New description body; overwrites `.tasks/<taskID>/description.md`",
  }),
  status: Schema.optional(Status).annotate({
    description: "New status: open, in_progress, done, or archived",
  }),
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

export const ProjectTaskUpdateTool = Tool.define<typeof UpdateParams, { task: unknown }, ProjectTask.Service>(
  "project_task_update",
  Effect.gen(function* () {
    const tasks = yield* ProjectTask.Service
    return {
      description: DESCRIPTION_UPDATE,
      parameters: UpdateParams,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "project_task_update",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const taskID = ProjectTaskID.make(params.taskID.trim())
          if (params.title === undefined && params.description === undefined && params.status === undefined) {
            return {
              title: "No project task fields to update",
              output: JSON.stringify({ error: "Provide at least one of title, description, status" }, null, 2),
              metadata: { task: null },
            }
          }
          const task = yield* tasks.update(taskID, {
            title: params.title,
            description: params.description,
            status: params.status,
          })
          return {
            title: `Updated project task: ${task.title}`,
            output: JSON.stringify(task, null, 2),
            metadata: { task },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof UpdateParams, { task: unknown }>
  }),
)
