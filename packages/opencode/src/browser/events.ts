import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const Updated = BusEvent.define(
  "browser.updated",
  Schema.Struct({
    pageID: Schema.optional(Schema.String),
    profileID: Schema.optional(Schema.String),
    owner: Schema.optional(
      Schema.Struct({ directory: Schema.optional(Schema.String), sessionID: Schema.optional(Schema.String) }),
    ),
    kind: Schema.optional(Schema.Literals(["user", "agent", "consultation", "login"])),
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
    pageID: Schema.optional(Schema.String),
    partition: Schema.String,
    profileID: Schema.optional(Schema.String),
    epoch: Schema.optional(Schema.Number),
  }),
)

export const GptProNotificationReceived = BusEvent.define(
  "gpt-pro.notification",
  Schema.Struct({
    id: Schema.String,
    consultationID: Schema.String,
    owner: Schema.String,
    phase: Schema.Literals([
      "queued",
      "preparing",
      "sending",
      "generating",
      "completed",
      "paused",
      "cancelled",
      "failed",
      "interrupted",
      "send_uncertain",
    ]),
    revision: Schema.Number,
    at: Schema.Number,
    url: Schema.String,
    kind: Schema.Literals(["progress", "completed", "state"]),
    format: Schema.Literals(["append", "snapshot"]),
    text: Schema.String,
    truncated: Schema.Boolean,
    error: Schema.optional(Schema.String),
    recovery: Schema.optional(
      Schema.Struct({
        stage: Schema.Literals(["open", "ready", "model", "compose", "submit", "track"]),
        reason: Schema.String,
        needsHuman: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
)
