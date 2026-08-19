import type { Part } from "@opencode-ai/sdk/v2"

type VirtualItemGeometry = {
  key: string | number | bigint
  index: number
  start: number
  size: number
}

/** Ignores virtualizer object churn when a mounted row's geometry is unchanged. */
export function sameVirtualItemGeometry(previous: VirtualItemGeometry, next: VirtualItemGeometry) {
  return (
    previous.key === next.key &&
    previous.index === next.index &&
    previous.start === next.start &&
    previous.size === next.size
  )
}

/** One getVirtualItems() snapshot so For keys and row lookups cannot diverge. */
export function snapshotVirtualItems<T extends { key: string | number | bigint }>(
  items: ReadonlyArray<T | undefined>,
) {
  const list = items.filter((item): item is T => item !== undefined)
  const keys: string[] = []
  const byKey = new Map<string, T>()
  for (const item of list) {
    const key = String(item.key)
    keys.push(key)
    byKey.set(key, item)
  }
  return { items: list, keys, byKey }
}

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

/**
 * Compensates scroll only for rows entirely above the viewport, so the visible
 * slice stays put. A spanning or in-view row can grow downward (streaming)
 * without pushing the viewport up. Bottom-anchored follow still always adjusts.
 */
export function shouldAdjustVirtualScroll(input: {
  itemEnd: number
  scrollOffset: number
  bottomAnchored: boolean
  initializing: boolean
}) {
  return input.itemEnd <= input.scrollOffset || (input.bottomAnchored && !input.initializing)
}

/** Streaming rows must not use size containment or the virtualizer freezes their height. */
export function timelineRowContentVisibility(input: {
  index: number
  activeIndex: number | undefined
  lastIndex: number
}) {
  return input.index === input.activeIndex || input.index === input.lastIndex ? "visible" : "auto"
}

/**
 * Ease only large live jumps. Small streaming deltas must snap, otherwise the
 * jump-to-bottom control stays visible while follow-scroll lags the true bottom.
 */
export function shouldEaseLiveBottom(distance: number, input: { min: number; max: number }) {
  const abs = Math.abs(distance)
  return abs > input.min && abs <= input.max
}

/** Prefers the larger box so content-visibility cannot under-report a growing row. */
export function measureTimelineRowHeight(element: HTMLElement) {
  return Math.max(element.getBoundingClientRect().height, element.offsetHeight, element.scrollHeight)
}

/** A live row can grow immediately, but a transient short measure must not shrink it. */
export function shouldCommitVirtualRowHeight(input: { next: number; previous: number; live: boolean }) {
  if (!input.live) return true
  return input.next + 0.5 >= input.previous
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
