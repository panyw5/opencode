import { ProjectTask } from "@/project-task/service"
import { ProjectTaskID } from "@/project-task/schema"
import { SessionID } from "@/session/schema"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ListQuery } from "../groups/project-task"

const notFound = () => new HttpApiError.NotFound({})
const badRequest = () => new HttpApiError.BadRequest({})

export const projectTaskHandlers = HttpApiBuilder.group(InstanceHttpApi, "project-task", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* ProjectTask.Service

    return handlers
      .handle("list", (ctx: { query: typeof ListQuery.Type }) =>
        tasks.list({ includeArchived: ctx.query.includeArchived }),
      )
      .handle("create", (ctx) =>
        tasks.create(ctx.payload).pipe(Effect.mapError(() => badRequest())),
      )
      .handle("get", (ctx: { params: { taskID: ProjectTaskID } }) =>
        tasks.get(ctx.params.taskID).pipe(Effect.mapError(notFound)),
      )
      .handle("detail", (ctx: { params: { taskID: ProjectTaskID } }) =>
        tasks.detail(ctx.params.taskID).pipe(Effect.mapError(notFound)),
      )
      .handle("update", (ctx) =>
        tasks.update(ctx.params.taskID, ctx.payload).pipe(
          Effect.catchTags({
            "ProjectTask.NotFoundError": () => Effect.fail(notFound()),
            "ProjectTask.InvalidMountError": () => Effect.fail(badRequest()),
          }),
        ),
      )
      .handle("archive", (ctx: { params: { taskID: ProjectTaskID } }) =>
        tasks.archive(ctx.params.taskID).pipe(Effect.mapError(notFound)),
      )
      .handle("mount", (ctx: { params: { sessionID: SessionID }; payload: { taskID: ProjectTaskID } }) =>
        tasks.mount({ sessionID: ctx.params.sessionID, taskID: ctx.payload.taskID }).pipe(
          Effect.flatMap((task) => (task ? Effect.succeed(task) : Effect.fail(badRequest()))),
          Effect.catchTags({
            "ProjectTask.NotFoundError": () => Effect.fail(notFound()),
            "ProjectTask.SessionNotFoundError": () => Effect.fail(notFound()),
            "ProjectTask.InvalidMountError": () => Effect.fail(badRequest()),
          }),
        ),
      )
      .handle("unmount", (ctx: { params: { sessionID: SessionID } }) =>
        tasks.mount({ sessionID: ctx.params.sessionID, taskID: null }).pipe(
          Effect.catchTags({
            "ProjectTask.NotFoundError": () => Effect.fail(notFound()),
            "ProjectTask.SessionNotFoundError": () => Effect.fail(notFound()),
            "ProjectTask.InvalidMountError": () => Effect.fail(badRequest()),
          }),
        ),
      )
  }),
)
