import { ProjectID } from "@/project/schema"
import { ScheduledTask } from "@/scheduled-task/service"
import { CreateInput, Info, Run, ScheduledTaskID, UpdateInput } from "@/scheduled-task/schema"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { described } from "./metadata"
import { QueryBoolean } from "./query"

const root = "/scheduled-task"

export const ListQuery = Schema.Struct({
  projectID: Schema.optional(ProjectID),
  enabled: Schema.optional(QueryBoolean),
})

export const RunsQuery = Schema.Struct({
  limit: Schema.optional(NonNegativeInt),
})

export const ScheduledTaskPaths = {
  list: root,
  get: `${root}/:taskID`,
  runs: `${root}/:taskID/run`,
  runNow: `${root}/:taskID/run-now`,
} as const

export const ScheduledTaskApi = HttpApi.make("scheduled-task").add(
  HttpApiGroup.make("scheduled-task")
    .add(
      HttpApiEndpoint.get("list", ScheduledTaskPaths.list, {
        query: ListQuery,
        success: described(Schema.Array(Info), "Scheduled tasks"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.list",
          summary: "List scheduled tasks",
          description: "List scheduled Agent prompt tasks across projects, optionally filtered by project or state.",
        }),
      ),
      HttpApiEndpoint.post("create", ScheduledTaskPaths.list, {
        payload: CreateInput,
        success: described(Info, "Created scheduled task"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "scheduledTask.create",
          summary: "Create scheduled task",
          description: "Create an unattended scheduled Agent prompt task.",
        }),
      ),
      HttpApiEndpoint.get("get", ScheduledTaskPaths.get, {
        params: { taskID: ScheduledTaskID },
        success: described(Info, "Scheduled task"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "scheduledTask.get", summary: "Get scheduled task" })),
      HttpApiEndpoint.patch("update", ScheduledTaskPaths.get, {
        params: { taskID: ScheduledTaskID },
        payload: UpdateInput,
        success: described(Info, "Updated scheduled task"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
      }).annotateMerge(OpenApi.annotations({ identifier: "scheduledTask.update", summary: "Update scheduled task" })),
      HttpApiEndpoint.delete("remove", ScheduledTaskPaths.get, {
        params: { taskID: ScheduledTaskID },
        success: described(Schema.Boolean, "Scheduled task removed"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "scheduledTask.remove", summary: "Remove scheduled task" })),
      HttpApiEndpoint.get("runs", ScheduledTaskPaths.runs, {
        params: { taskID: ScheduledTaskID },
        query: RunsQuery,
        success: described(Schema.Array(Run), "Scheduled task runs"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "scheduledTask.runs", summary: "List scheduled task runs" })),
      HttpApiEndpoint.post("runNow", ScheduledTaskPaths.runNow, {
        params: { taskID: ScheduledTaskID },
        success: described(Run, "Started scheduled task run"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "scheduledTask.runNow", summary: "Run scheduled task now" })),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "scheduled-task",
        description: "Global unattended Agent prompt scheduling routes.",
      }),
    )
    .middleware(Authorization),
)
