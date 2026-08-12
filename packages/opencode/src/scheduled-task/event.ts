import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"
import { Info, Run, ScheduledTaskID } from "./schema"

export const Event = {
  Created: BusEvent.define("scheduled-task.created", Info),
  Updated: BusEvent.define("scheduled-task.updated", Info),
  Deleted: BusEvent.define("scheduled-task.deleted", Schema.Struct({ taskID: ScheduledTaskID })),
  RunUpdated: BusEvent.define("scheduled-task.run-updated", Run),
}

export * as ScheduledTaskEvent from "./event"
