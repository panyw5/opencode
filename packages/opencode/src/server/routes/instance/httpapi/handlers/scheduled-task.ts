import { Project } from "@/project/project"
import { ScheduledTask } from "@/scheduled-task/service"
import { ScheduledTaskID } from "@/scheduled-task/schema"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ListQuery, RunsQuery } from "../groups/scheduled-task"

const notFound = () => new HttpApiError.NotFound({})

export const scheduledTaskHandlers = HttpApiBuilder.group(InstanceHttpApi, "scheduled-task", (handlers) =>
  Effect.gen(function* () {
    const scheduled = yield* ScheduledTask.Service
    const projects = yield* Project.Service

    return handlers
      .handle("list", (ctx: { query: typeof ListQuery.Type }) =>
        Effect.gen(function* () {
          const locationID = ctx.query.locationID
            ? ctx.query.locationID
            : ctx.query.directory
              ? (yield* projects.fromDirectory(ctx.query.directory)).location.id
              : undefined
          return yield* scheduled.list({
            projectID: ctx.query.projectID,
            locationID,
            enabled: ctx.query.enabled,
          })
        }),
      )
      .handle("create", (ctx) =>
        scheduled.create(ctx.payload).pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
      .handle("get", (ctx) => scheduled.get(ctx.params.taskID).pipe(Effect.mapError(notFound)))
      .handle("update", (ctx) =>
        scheduled.update(ctx.params.taskID, ctx.payload).pipe(
          Effect.catchTag("ScheduledTask.NotFoundError", () => Effect.fail(notFound())),
          Effect.mapError((error) =>
            error instanceof HttpApiError.NotFound ? error : new HttpApiError.BadRequest({}),
          ),
        ),
      )
      .handle("remove", (ctx) => scheduled.remove(ctx.params.taskID).pipe(Effect.mapError(notFound), Effect.as(true)))
      .handle("runs", (ctx: { params: { taskID: ScheduledTaskID }; query: typeof RunsQuery.Type }) =>
        scheduled.runs(ctx.params.taskID, ctx.query.limit).pipe(Effect.mapError(notFound)),
      )
      .handle("runNow", (ctx) => scheduled.runNow(ctx.params.taskID).pipe(Effect.mapError(notFound)))
  }),
)
