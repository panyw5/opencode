import type { Part } from "@opencode-ai/sdk/v2"

export function scheduleConnectedMeasure<T extends HTMLElement>(element: T, measure: (element: T) => void) {
  return requestAnimationFrame(() => {
    if (element.isConnected) measure(element)
  })
}

export function createCoalescedConnectedMeasure<T extends HTMLElement>(input: {
  element: () => T | undefined
  measure: (element: T) => number
  commit: (element: T, height: number) => void
  tolerance?: number
}) {
  let frame: number | undefined
  let committedHeight: number | undefined
  const tolerance = input.tolerance ?? 0.5

  const request = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      const element = input.element()
      if (!element?.isConnected) return
      const height = input.measure(element)
      if (committedHeight !== undefined && Math.abs(height - committedHeight) <= tolerance) return
      committedHeight = height
      input.commit(element, height)
    })
  }

  return {
    request,
    cancel: () => {
      if (frame === undefined) return
      cancelAnimationFrame(frame)
      frame = undefined
    },
    remember: (height: number) => {
      committedHeight = height
    },
  }
}

export function timelineMeasurementsMatchWidth(cachedWidth: number | undefined, currentWidth: number) {
  if (!cachedWidth || !currentWidth) return true
  return Math.abs(cachedWidth - currentWidth) <= 16
}

/** Keeps a growing row readable until its deferred virtualizer measurement commits. */
export function virtualRowOverflow(contentHeight: number, virtualHeight: number) {
  return contentHeight > virtualHeight + 0.5 ? "visible" : "clip"
}

/** Keeps a bottom-anchored stream pinned when its last virtual row grows. */
export function shouldAdjustVirtualScroll(input: {
  itemEnd: number
  scrollOffset: number
  bottomAnchored: boolean
  initializing: boolean
}) {
  return input.itemEnd <= input.scrollOffset || (input.bottomAnchored && !input.initializing)
}

/** Keeps virtual row identity independent from the data that determines its height. */
export function partMeasurementKey(part: Part | undefined) {
  if (!part) return "missing"
  if (part.type === "text" || part.type === "reasoning")
    return `${part.type}:${part.text.length}:${part.time?.end ?? "live"}`
  if (part.type === "tool") {
    const state = part.state
    const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : ""
    const title = state.status === "running" || state.status === "completed" ? (state.title ?? "") : ""
    const metadata =
      state.status === "running" || state.status === "completed" || state.status === "error"
        ? state.metadata
        : undefined
    return `tool:${part.tool}:${state.status}:${title}:${output.length}:${JSON.stringify(metadata ?? {}).length}`
  }
  return `${part.type}:${JSON.stringify(part).length}`
}

export function timelineContentVersion(
  messages: readonly { id: string }[],
  parts: Record<string, Part[] | undefined>,
) {
  return messages
    .map((message) => `${message.id}:${(parts[message.id] ?? []).map(partMeasurementKey).join(",")}`)
    .join("|")
}
