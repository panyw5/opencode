import { ProjectLocation } from "@/project/location"
import { ScheduledTask } from "@/scheduled-task/service"
import { ScheduledTaskID } from "@/scheduled-task/schema"
import * as Log from "@opencode-ai/core/util/log"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { toLogicalPath } from "@opencode-ai/core/util/path"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ListQuery, RunsQuery } from "../groups/scheduled-task"

const notFound = () => new HttpApiError.NotFound({})
const log = Log.create({ service: "scheduled-task-http" })

export const scheduledTaskHandlers = HttpApiBuilder.group(InstanceHttpApi, "scheduled-task", (handlers) =>
  Effect.gen(function* () {
    const scheduled = yield* ScheduledTask.Service
    return handlers
      .handle("list", (ctx: { query: typeof ListQuery.Type }) =>
        Effect.gen(function* () {
          const started = Date.now()
          log.info("scheduled task list scope resolution started", {
            projectID: ctx.query.projectID,
            locationID: ctx.query.locationID,
            directory: ctx.query.directory,
          })
          const canonicalDirectory = ctx.query.directory
            ? toLogicalPath(AppFileSystem.resolve(ctx.query.directory))
            : undefined
          const persistedLocation = canonicalDirectory
            ? ProjectLocation.getByCanonicalDirectory(canonicalDirectory)
            : undefined
          const locationID = ctx.query.locationID
            ? ctx.query.locationID
            : persistedLocation
              ? persistedLocation.id
              : undefined
          if (canonicalDirectory && !locationID) {
            log.warn("scheduled task list skipped unresolved directory", { directory: canonicalDirectory })
            return []
          }
          const tasks = yield* scheduled.list({
            projectID: ctx.query.projectID,
            locationID,
            enabled: ctx.query.enabled,
          })
          log.info("scheduled task list scope resolution completed", {
            projectID: ctx.query.projectID,
            locationID,
            directory: ctx.query.directory,
            locationSource: ctx.query.locationID
              ? "query"
              : persistedLocation
                ? "persisted-location"
                : "none",
            durationMs: Date.now() - started,
            count: tasks.length,
          })
          return tasks
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
