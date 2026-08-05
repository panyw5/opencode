import {
  CreateInput,
  Detail,
  Info,
  MountInput,
  ProjectTaskID,
  UpdateInput,
} from "@/project-task/schema"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { QueryBoolean } from "./query"

const root = "/project-task"

export const ListQuery = Schema.Struct({
  includeArchived: Schema.optional(QueryBoolean),
})

export const ProjectTaskPaths = {
  list: root,
  get: `${root}/:taskID`,
  detail: `${root}/:taskID/detail`,
  mount: `/session/:sessionID/project-task`,
} as const

export const ProjectTaskApi = HttpApi.make("project-task").add(
  HttpApiGroup.make("project-task")
    .add(
      HttpApiEndpoint.get("list", ProjectTaskPaths.list, {
        query: ListQuery,
        success: described(Schema.Array(Info), "Project tasks"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "projectTask.list",
          summary: "List project tasks",
          description: "List project-level tasks for the current project, including todo progress summaries.",
        }),
      ),
      HttpApiEndpoint.post("create", ProjectTaskPaths.list, {
        payload: CreateInput,
        success: described(Info, "Created project task"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "projectTask.create",
          summary: "Create project task",
          description: "Create a project-level task that sessions can mount.",
        }),
      ),
      HttpApiEndpoint.get("get", ProjectTaskPaths.get, {
        params: { taskID: ProjectTaskID },
        query: WorkspaceRoutingQuery,
        success: described(Info, "Project task"),
        error: HttpApiError.NotFound,
      }).annotateMerge(OpenApi.annotations({ identifier: "projectTask.get", summary: "Get project task" })),
      HttpApiEndpoint.get("detail", ProjectTaskPaths.detail, {
        params: { taskID: ProjectTaskID },
        query: WorkspaceRoutingQuery,
        success: described(Detail, "Project task detail"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "projectTask.detail",
          summary: "Get project task detail",
          description: "Retrieve a project task with linked sessions and each session's todos.",
        }),
      ),
      HttpApiEndpoint.patch("update", ProjectTaskPaths.get, {
        params: { taskID: ProjectTaskID },
        payload: UpdateInput,
        success: described(Info, "Updated project task"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
      }).annotateMerge(OpenApi.annotations({ identifier: "projectTask.update", summary: "Update project task" })),
      HttpApiEndpoint.delete("archive", ProjectTaskPaths.get, {
        params: { taskID: ProjectTaskID },
        success: described(Info, "Archived project task"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "projectTask.archive",
          summary: "Archive project task",
          description: "Archive a project task and unmount it from all sessions.",
        }),
      ),
      HttpApiEndpoint.put("mount", ProjectTaskPaths.mount, {
        params: { sessionID: SessionID },
        payload: MountInput,
        success: described(Info, "Mounted project task"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "projectTask.mount",
          summary: "Mount project task on session",
          description: "Mount a project task onto a session (replaces any previous mount).",
        }),
      ),
      HttpApiEndpoint.delete("unmount", ProjectTaskPaths.mount, {
        params: { sessionID: SessionID },
        success: described(Schema.NullOr(Info), "Previously mounted project task"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "projectTask.unmount",
          summary: "Unmount project task from session",
          description: "Clear the project task mount for a session.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "project-task",
        description: "Project-level task management linked to session todos.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
