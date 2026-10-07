import { Schema } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import type { InstanceContext } from "@/project/instance-context"
import { ExtensionID, StatusProperties, type StatusProperties as Properties } from "./schema"

/**
 * Payload of a custom extension event (`extension.event`). Extensions cannot
 * define new Bus event types; they multiplex through `name` inside this single
 * event (see specs/extensions design.md §5.5).
 */
export const CustomProperties = Schema.Struct({
  id: ExtensionID,
  name: Schema.String,
  data: Schema.Unknown,
}).annotate({ identifier: "ExtensionEventProperties" })
export type CustomProperties = Schema.Schema.Type<typeof CustomProperties>

export const Event = {
  Status: BusEvent.define("extension.status", StatusProperties),
  Custom: BusEvent.define("extension.event", CustomProperties),
}

export function publish(properties: Properties) {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Status.type,
      properties,
    },
  })
}

export function publishError(id: ExtensionID, version: string, error: unknown) {
  publish({
    id,
    version,
    state: "error",
    error: error instanceof Error ? error.message : String(error),
  })
}

/**
 * Emit a custom `extension.event` process-wide. Delivered through GlobalBus
 * with `directory: "global"`, so every connected UI receives it regardless of
 * which instance it is attached to.
 */
export function emit(properties: CustomProperties) {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: Event.Custom.type,
      properties,
    },
  })
}

/**
 * Emit a custom `extension.event` through the Bus of a single instance, so
 * in-process subscribers and the UI routed to `ctx.directory` both receive it.
 */
export async function emitTo(ctx: InstanceContext, properties: CustomProperties) {
  await Bus.publish(ctx, Event.Custom, properties)
}

export * as ExtensionEvent from "./event"
