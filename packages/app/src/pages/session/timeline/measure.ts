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

export type ResizeObserverEntryLike = {
  borderBoxSize?: ReadonlyArray<{ blockSize?: number }> | { blockSize?: number }
  contentRect?: { height?: number }
}

/**
 * Extract an observed element's border-box height from a ResizeObserver entry
 * without any layout read. Priority per the measurement plan: borderBoxSize
 * block size, then contentRect.height (rows have no own padding/border, so the
 * boxes coincide). Returns undefined when the entry carries no usable size —
 * callers must then fall back to an explicit read.
 */
export function heightFromResizeObserverEntry(entry: ResizeObserverEntryLike | undefined): number | undefined {
  if (!entry) return undefined
  const box = entry.borderBoxSize
  const blockSize = Array.isArray(box) ? box[0]?.blockSize : (box as { blockSize?: number } | undefined)?.blockSize
  if (typeof blockSize === "number" && blockSize > 0) return blockSize
  const contentHeight = entry.contentRect?.height
  if (typeof contentHeight === "number" && contentHeight > 0) return contentHeight
  return undefined
}

export type ViewportAnchor = {
  /** Row key whose element pins the viewport; empty when no row is mounted. */
  key: string
  /** Distance from the anchor element's top to the viewport top. */
  offset: number
  /**
   * scrollTop at capture time. Height commits (while not bottom-anchored)
   * never move scrollTop, so a changed scrollTop on restore means the user
   * (or a programmatic scroll) moved the viewport — the anchor must be
   * re-captured instead of "corrected", otherwise restore fights the user.
   */
  scrollTop: number
}

/**
 * Capture which mounted row the user is looking at, so a later batch of height
 * commits can restore the viewport exactly (C1). The anchor is the row
 * spanning the viewport top (its top may sit above the fold), or the first
 * row below it when the top falls between rows.
 */
export function captureViewportAnchor(
  root: HTMLElement,
  elements: ReadonlyArray<HTMLElement>,
): ViewportAnchor | undefined {
  const view = root.getBoundingClientRect()
  let fallback: HTMLElement | undefined
  for (const element of elements) {
    const rect = element.getBoundingClientRect()
    if (rect.bottom <= view.top) continue
    if (rect.top <= view.top)
      return { key: element.dataset.timelineKey ?? "", offset: rect.top - view.top, scrollTop: root.scrollTop }
    fallback ??= element
    break
  }
  if (fallback) {
    const rect = fallback.getBoundingClientRect()
    return { key: fallback.dataset.timelineKey ?? "", offset: rect.top - view.top, scrollTop: root.scrollTop }
  }
  return undefined
}

/**
 * Re-pin the anchor row to its captured offset. Returns the applied delta;
 * 0 means the viewport already matches (idempotent with TanStack's own
 * above-viewport compensation, which leaves no residual to fix).
 *
 * Skips entirely when scrollTop moved since capture: that displacement came
 * from user scrolling or a programmatic scroll, not from a height commit —
 * restoring would fight the scroll instead of fixing a jump.
 */
export function restoreViewportAnchor(input: {
  root: HTMLElement
  anchor: ViewportAnchor
  elementByKey: (key: string) => HTMLElement | undefined
  tolerance?: number
}): number {
  const { root, anchor, elementByKey } = input
  const tolerance = input.tolerance ?? 1
  if (!anchor.key) return 0
  if (Math.abs(root.scrollTop - anchor.scrollTop) > 0.5) return 0
  const element = elementByKey(anchor.key)
  if (!element?.isConnected) return 0
  const delta = element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset
  if (Math.abs(delta) <= tolerance) return 0
  root.scrollTop += delta
  return delta
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

/**
 * Input shape for {@link rowContentVersion}. The fields mirror the relevant
 * subsets of {@link TimelineRow.TimelineRow} without importing the class,
 * keeping measure.ts free of a circular dependency on rows.ts.
 */
export type RowContentVersionInput = {
  _tag: string
  userMessageID?: string
  group?: {
    type: "part" | "context"
    ref?: { messageID: string; partID: string }
    refs?: ReadonlyArray<{ messageID: string; partID: string }>
  }
  label?: string
  phase?: string
  reasoningHeading?: string
  diffs?: ReadonlyArray<{ file: string }>
  text?: string
}

/**
 * Compute a content version for a single timeline row, independent of every
 * other row. Only fields that affect the row's rendered height are included,
 * so a new message elsewhere does not invalidate this row's cached height (C2).
 *
 * The `parts` accessor is used to resolve the underlying `Part` objects for
 * `AssistantPart` rows; for other row types the version is computed from the
 * row's own structural fields.
 */
export function rowContentVersion(
  row: RowContentVersionInput,
  parts: (messageID: string, partID: string) => Part | undefined,
): string {
  switch (row._tag) {
    case "TurnGap":
      return "gap"

    case "CommentStrip":
      return `comments:${row.userMessageID ?? ""}`

    case "UserMessage":
      return `user:${row.userMessageID ?? ""}`

    case "TurnDivider":
      return `divider:${row.userMessageID ?? ""}:${row.label ?? ""}`

    case "AssistantPart": {
      const group = row.group
      if (!group) return "assistant:missing"
      if (group.type === "part" && group.ref) {
        const part = parts(group.ref.messageID, group.ref.partID)
        return `part:${partMeasurementKey(part)}`
      }
      if (group.type === "context" && group.refs) {
        return `ctx:${group.refs
          .map((ref) => partMeasurementKey(parts(ref.messageID, ref.partID)))
          .join(",")}`
      }
      return "assistant:missing"
    }

    case "Thinking":
      return `thinking:${row.phase ?? ""}:${row.reasoningHeading?.length ?? 0}`

    case "Retry":
      return "retry"

    case "DiffSummary":
      return `diff:${row.diffs?.length ?? 0}`

    case "Error":
      return `error:${(row.text ?? "").length}`

    default:
      return `unknown:${row._tag}`
  }
}
