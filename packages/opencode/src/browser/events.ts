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
  }),
)
