import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { StatusProperties, type ExtensionID, type StatusProperties as Properties } from "./schema"

export const Event = {
  Status: BusEvent.define("extension.status", StatusProperties),
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

export * as ExtensionEvent from "./event"
