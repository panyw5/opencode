import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const Updated = BusEvent.define(
  "browser.updated",
  Schema.Struct({
    partition: Schema.String,
    url: Schema.String,
    title: Schema.String,
    loading: Schema.Boolean,
    shared: Schema.Boolean,
    epoch: Schema.optional(Schema.Number),
  }),
)

// Mirrors the desktop's view teardowns. `epoch` is the generation of the view
// that was closed; state events with `epoch <= closedEpoch` are stale and must
// be dropped by consumers.
export const Closed = BusEvent.define(
  "browser.closed",
  Schema.Struct({
    partition: Schema.String,
    epoch: Schema.optional(Schema.Number),
  }),
)
