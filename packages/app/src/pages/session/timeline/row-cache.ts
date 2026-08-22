import type { VirtualItem } from "@tanstack/solid-virtual"

/**
 * Quality of a row height measurement.
 * - "estimated": computed from row structure without DOM measurement
 * - "measured": observed from a live ResizeObserver / getBoundingClientRect
 *
 * Measured values always take precedence over estimated ones unless the
 * content version has changed (which invalidates the measurement entirely).
 */
export type RowMeasurementQuality = "estimated" | "measured"

export type RowMeasurement = {
  height: number
  quality: RowMeasurementQuality
  /** Content version that produced this height. Stale versions must be ignored. */
  contentVersion: string
  /** Container width when measured. Width changes invalidate the measurement. */
  width: number
  /** Monotonic timestamp so a late async measure cannot overwrite a fresher one. */
  measuredAt: number
}

/** Width tolerance reuses cached heights across minor layout shifts (scrollbar, etc). */
const WIDTH_TOLERANCE = 16

export function rowWidthCompatible(cachedWidth: number, currentWidth: number) {
  if (!cachedWidth || !currentWidth) return true
  return Math.abs(cachedWidth - currentWidth) <= WIDTH_TOLERANCE
}

/**
 * Per-row height cache keyed by `TimelineRow.key`.
 *
 * The previous implementation cached an entire session measurement snapshot
 * under a single `contentVersion` string; any new message invalidated every
 * row's height, even those whose content was unchanged. This row-level cache
 * lets a single new message keep all previously-measured row heights valid.
 *
 * Lifecycle:
 * - `get` returns a measurement only if contentVersion matches and width is compatible.
 * - `set` refuses to overwrite a "measured" entry with an "estimated" one
 *   unless the contentVersion changed (C2: estimated never covers measured).
 * - `set` always accepts a "measured" entry over a previous "estimated" one.
 * - `evict` removes a single row; `evictPrefix` removes rows that share a key
 *   prefix (used to clear a whole session on switch).
 * - `snapshot` / `restore` persist the cache across tab switches.
 */
export class TimelineRowMeasurementCache {
  private rows = new Map<string, RowMeasurement>()

  get(rowKey: string): RowMeasurement | undefined {
    return this.rows.get(rowKey)
  }

  /** Returns a valid cached height, or undefined when stale/missing/incompatible. */
  getHeight(rowKey: string, contentVersion: string, width: number): number | undefined {
    const entry = this.rows.get(rowKey)
    if (!entry) return undefined
    if (entry.contentVersion !== contentVersion) return undefined
    if (!rowWidthCompatible(entry.width, width)) return undefined
    return entry.height
  }

  getQuality(rowKey: string): RowMeasurementQuality | undefined {
    return this.rows.get(rowKey)?.quality
  }

  /**
   * Write a measurement, enforcing quality precedence.
   *
   * - A "measured" entry always wins over a previous "estimated" entry.
   * - An "estimated" entry never overwrites a "measured" entry whose
   *   contentVersion is still current (C2).
   * - When the contentVersion changed, either quality is accepted because the
   *   old measurement is no longer valid.
   * - A newer measurement (higher measuredAt) always wins over an older one
   *   of equal quality, preventing a late async measure from regressing a
   *   freshly committed height.
   */
  set(rowKey: string, measurement: RowMeasurement): void {
    const existing = this.rows.get(rowKey)
    if (existing) {
      // Same content: enforce quality + recency precedence.
      if (existing.contentVersion === measurement.contentVersion) {
        if (existing.quality === "measured" && measurement.quality === "estimated") return
        if (
          existing.quality === measurement.quality &&
          existing.measuredAt > measurement.measuredAt
        ) {
          return
        }
      }
    }
    this.rows.set(rowKey, measurement)
  }

  /** Convenience for measured heights. */
  setMeasured(rowKey: string, height: number, contentVersion: string, width: number): void {
    this.set(rowKey, {
      height,
      quality: "measured",
      contentVersion,
      width,
      measuredAt: performance.now(),
    })
  }

  /** Convenience for estimated heights (measuredAt = 0 so any measured value wins). */
  setEstimated(rowKey: string, height: number, contentVersion: string, width: number): void {
    this.set(rowKey, {
      height,
      quality: "estimated",
      contentVersion,
      width,
      measuredAt: 0,
    })
  }

  evict(rowKey: string): void {
    this.rows.delete(rowKey)
  }

  evictPrefix(prefix: string): void {
    for (const key of [...this.rows.keys()]) {
      if (key.startsWith(prefix)) this.rows.delete(key)
    }
  }

  clear(): void {
    this.rows.clear()
  }

  get size(): number {
    return this.rows.size
  }

  has(rowKey: string): boolean {
    return this.rows.has(rowKey)
  }

  /**
   * Produce a plain snapshot suitable for serialising across tab switches.
   * The returned map is a shallow copy; callers must not mutate entries.
   */
  snapshot(): Map<string, RowMeasurement> {
    return new Map(this.rows)
  }

  /** Restore a previous snapshot, merging over the current entries. */
  restore(snapshot: Map<string, RowMeasurement>): void {
    for (const [key, entry] of snapshot) {
      // Respect quality precedence during restore.
      this.set(key, entry)
    }
  }

  /**
   * Convert the row cache into the `VirtualItem[]` shape TanStack virtualizer
   * expects for `initialMeasurementsCache`.
   *
   * Only rows with a known height are emitted; the virtualizer falls back to
   * `estimateSize` for the rest.
   */
  toVirtualMeasurements(
    rowIndexByKey: Map<string, number>,
  ): VirtualItem[] {
    const items: VirtualItem[] = []
    let start = 0
    // Iterate in index order so `start` accumulates correctly.
    const keyByIndex = new Map<number, string>()
    for (const [key, index] of rowIndexByKey) keyByIndex.set(index, key)

    const count = rowIndexByKey.size
    for (let index = 0; index < count; index++) {
      const key = keyByIndex.get(index)
      const entry = key ? this.rows.get(key) : undefined
      const size = entry?.height ?? 0
      if (entry && size > 0) {
        items.push({
          key,
          index,
          start,
          end: start + size,
          size,
          lane: 0,
        } as VirtualItem)
      }
      start += size
    }
    return items
  }
}

/**
 * Module-level singleton shared across timeline mounts.
 *
 * Different sessions use different `rowKey` prefixes (`user-message:…`,
 * `assistant-part:…`, etc.) that embed the message/part IDs, so there is no
 * risk of cross-session collision; `evictPrefix` can clear a session on
 * unmount if memory becomes a concern.
 */
export const timelineRowCache = new TimelineRowMeasurementCache()
