import type { Part } from "@opencode-ai/sdk/v2"

export function scheduleConnectedMeasure<T extends HTMLElement>(element: T, measure: (element: T) => void) {
  return requestAnimationFrame(() => {
    if (element.isConnected) measure(element)
  })
}

export function timelineMeasurementsMatchWidth(cachedWidth: number | undefined, currentWidth: number) {
  if (!cachedWidth || !currentWidth) return true
  return Math.abs(cachedWidth - currentWidth) <= 16
}

/** Keeps virtual row identity independent from the data that determines its height. */
export function partMeasurementKey(part: Part | undefined) {
  if (!part) return "missing"
  if (part.type === "text" || part.type === "reasoning") return `${part.type}:${part.text.length}:${part.time?.end ?? "live"}`
  if (part.type === "tool") {
    const state = part.state
    const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : ""
    const title = state.status === "running" || state.status === "completed" ? state.title ?? "" : ""
    const metadata = state.status === "running" || state.status === "completed" || state.status === "error" ? state.metadata : undefined
    return `tool:${part.tool}:${state.status}:${title}:${output.length}:${JSON.stringify(metadata ?? {}).length}`
  }
  return `${part.type}:${JSON.stringify(part).length}`
}
