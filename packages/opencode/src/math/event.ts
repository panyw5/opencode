import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const Status = BusEvent.define(
  "math.worker.status",
  Schema.Struct({
    sessionID: Schema.String,
    parentSessionID: Schema.optional(Schema.String),
    state: Schema.String,
    alive: Schema.Boolean,
    pid: Schema.optional(Schema.Number),
    round: Schema.optional(Schema.Number),
    lastFactId: Schema.optional(Schema.String),
    reason: Schema.String,
  }),
)

export * as MathWorkerEvent from "./event"
