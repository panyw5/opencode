import { GlobalBus } from "@/bus/global"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { ScheduledTaskRepository } from "./repository"
import { NotFoundError, ScheduledTaskID, UpdateInput } from "./schema"
import { Event } from "./event"

const log = Log.create({ service: "scheduled-task.mutate" })

export const update = Effect.fn("ScheduledTask.update")(function* (id: ScheduledTaskID, input: UpdateInput) {
  log.info("updating scheduled task", { taskID: id, input })
  const task = yield* ScheduledTaskRepository.update(id, input)
  if (!task) return yield* new NotFoundError({ taskID: id })
  log.info("scheduled task updated", { taskID: id, nextRunAt: task.nextRunAt })
  yield* Effect.sync(() =>
    GlobalBus.emit("event", {
      directory: task.directory,
      payload: { type: Event.Updated.type, properties: task },
    }),
  )
  return task
})

export const remove = Effect.fn("ScheduledTask.remove")(function* (id: ScheduledTaskID) {
  const task = yield* ScheduledTaskRepository.get(id)
  if (!task) return yield* new NotFoundError({ taskID: id })
  yield* ScheduledTaskRepository.remove(id)
  log.info("scheduled task removed", { taskID: id, directory: task.directory })
  yield* Effect.sync(() =>
    GlobalBus.emit("event", {
      directory: task.directory,
      payload: { type: Event.Deleted.type, properties: { taskID: id } },
    }),
  )
})

export * as ScheduledTaskMutate from "./mutate"
