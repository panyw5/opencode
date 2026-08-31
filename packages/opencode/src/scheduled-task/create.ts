import { GlobalBus } from "@/bus/global"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { ScheduledTaskRepository } from "./repository"
import type { CreateInput } from "./schema"
import { Event } from "./event"
import type { LocationID } from "@/project/schema"

const log = Log.create({ service: "scheduled-task.create" })

export const create = Effect.fn("ScheduledTask.create")(function* (input: CreateInput, locationID: LocationID) {
  log.info("persisting scheduled task", {
    projectID: input.projectID,
    directory: input.directory,
    name: input.name,
    scheduleKind: input.schedule.kind,
    executionMode: input.executionMode ?? "existing_session",
    enabled: input.enabled ?? true,
  })
  const task = yield* ScheduledTaskRepository.create({ ...input, locationID })
  log.info("scheduled task persisted", { taskID: task.id, projectID: task.projectID, nextRunAt: task.nextRunAt })
  yield* Effect.sync(() =>
    GlobalBus.emit("event", {
      directory: task.directory,
      payload: { type: Event.Created.type, properties: task },
    }),
  )
  log.info("scheduled task created event emitted", { taskID: task.id, directory: task.directory })
  return task
})

export * as ScheduledTaskCreate from "./create"
