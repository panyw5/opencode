import { describe, expect, test } from "bun:test"
import {
  BoundedTimelineRowMeasurementCache,
  TimelineRowMeasurementCache,
  rowWidthCompatible,
  type RowMeasurement,
} from "./row-cache"

describe("TimelineRowMeasurementCache", () => {
  test("returns undefined for a missing row", () => {
    const cache = new TimelineRowMeasurementCache()
    expect(cache.getHeight("row-1", "v1", 800)).toBeUndefined()
  })

  test("stores and returns a measured height", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 120, "v1", 800)
    expect(cache.getHeight("row-1", "v1", 800)).toBe(120)
    expect(cache.getQuality("row-1")).toBe("measured")
  })

  test("stores and returns an estimated height", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setEstimated("row-1", 60, "v1", 800)
    expect(cache.getHeight("row-1", "v1", 800)).toBe(60)
    expect(cache.getQuality("row-1")).toBe("estimated")
  })

  test("rejects a stale content version (C2)", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 120, "v1", 800)
    expect(cache.getHeight("row-1", "v2", 800)).toBeUndefined()
  })

  test("rejects an incompatible width", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 120, "v1", 800)
    expect(cache.getHeight("row-1", "v1", 840)).toBeUndefined()
  })

  test("accepts a width within tolerance", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 120, "v1", 800)
    expect(cache.getHeight("row-1", "v1", 808)).toBe(120)
  })

  test("measured overwrites estimated with the same content version", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setEstimated("row-1", 60, "v1", 800)
    cache.setMeasured("row-1", 124, "v1", 800)
    expect(cache.getHeight("row-1", "v1", 800)).toBe(124)
    expect(cache.getQuality("row-1")).toBe("measured")
  })

  test("estimated does not overwrite measured with the same content version (C2)", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 124, "v1", 800)
    cache.setEstimated("row-1", 60, "v1", 800)
    expect(cache.getHeight("row-1", "v1", 800)).toBe(124)
    expect(cache.getQuality("row-1")).toBe("measured")
  })

  test("estimated is accepted when content version changed", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 124, "v1", 800)
    cache.setEstimated("row-1", 60, "v2", 800)
    expect(cache.getHeight("row-1", "v2", 800)).toBe(60)
    expect(cache.getQuality("row-1")).toBe("estimated")
  })

  test("measured is accepted when content version changed", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setEstimated("row-1", 60, "v1", 800)
    cache.setMeasured("row-1", 130, "v2", 800)
    expect(cache.getHeight("row-1", "v2", 800)).toBe(130)
    expect(cache.getQuality("row-1")).toBe("measured")
  })

  test("a later measuredAt wins over an earlier one of equal quality", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.set("row-1", {
      height: 100,
      quality: "measured",
      contentVersion: "v1",
      width: 800,
      measuredAt: 1000,
    })
    cache.set("row-1", {
      height: 110,
      quality: "measured",
      contentVersion: "v1",
      width: 800,
      measuredAt: 2000,
    })
    expect(cache.getHeight("row-1", "v1", 800)).toBe(110)
  })

  test("an earlier measuredAt does not overwrite a later one", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.set("row-1", {
      height: 110,
      quality: "measured",
      contentVersion: "v1",
      width: 800,
      measuredAt: 2000,
    })
    cache.set("row-1", {
      height: 100,
      quality: "measured",
      contentVersion: "v1",
      width: 800,
      measuredAt: 1000,
    })
    expect(cache.getHeight("row-1", "v1", 800)).toBe(110)
  })

  test("evicts a single row", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 120, "v1", 800)
    cache.evict("row-1")
    expect(cache.has("row-1")).toBe(false)
    expect(cache.size).toBe(0)
  })

  test("evicts rows by key prefix", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("assistant-part:msg_a:prt_1", 120, "v1", 800)
    cache.setMeasured("assistant-part:msg_b:prt_2", 130, "v1", 800)
    cache.setMeasured("user-message:msg_a", 80, "v1", 800)
    cache.evictPrefix("assistant-part:msg_a:")
    expect(cache.has("assistant-part:msg_a:prt_1")).toBe(false)
    expect(cache.has("assistant-part:msg_b:prt_2")).toBe(true)
    expect(cache.has("user-message:msg_a")).toBe(true)
  })

  test("clears all entries", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 120, "v1", 800)
    cache.setMeasured("row-2", 130, "v1", 800)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  test("evicts the oldest measurement when explicitly bounded", () => {
    const cache = new BoundedTimelineRowMeasurementCache(2)
    cache.setMeasured("row-1", 100, "v1", 800)
    cache.setMeasured("row-2", 110, "v1", 800)
    cache.setMeasured("row-3", 120, "v1", 800)

    expect(cache.has("row-1")).toBe(false)
    expect(cache.has("row-2")).toBe(true)
    expect(cache.has("row-3")).toBe(true)
  })

  test("refreshes insertion order when updating a bounded measurement", () => {
    const cache = new BoundedTimelineRowMeasurementCache(2)
    cache.setMeasured("row-1", 100, "v1", 800)
    cache.setMeasured("row-2", 110, "v1", 800)
    cache.setMeasured("row-1", 105, "v2", 800)
    cache.setMeasured("row-3", 120, "v1", 800)

    expect(cache.has("row-1")).toBe(true)
    expect(cache.has("row-2")).toBe(false)
    expect(cache.has("row-3")).toBe(true)
  })

  test("snapshots and restores across tab switches", () => {
    const original = new TimelineRowMeasurementCache()
    original.setMeasured("row-1", 120, "v1", 800)
    original.setEstimated("row-2", 60, "v1", 800)

    const snap = original.snapshot()
    expect(snap.size).toBe(2)

    const restored = new TimelineRowMeasurementCache()
    restored.restore(snap)
    expect(restored.getHeight("row-1", "v1", 800)).toBe(120)
    expect(restored.getHeight("row-2", "v1", 800)).toBe(60)
  })

  test("restore respects quality precedence", () => {
    const cache = new TimelineRowMeasurementCache()
    cache.setMeasured("row-1", 124, "v1", 800)

    const snap = new Map<string, RowMeasurement>([
      [
        "row-1",
        {
          height: 60,
          quality: "estimated",
          contentVersion: "v1",
          width: 800,
          measuredAt: 0,
        },
      ],
    ])
    cache.restore(snap)
    // Measured must not be overwritten by estimated.
    expect(cache.getHeight("row-1", "v1", 800)).toBe(124)
  })
})

describe("rowWidthCompatible", () => {
  test("accepts identical widths", () => {
    expect(rowWidthCompatible(800, 800)).toBe(true)
  })

  test("accepts widths within 16px tolerance", () => {
    expect(rowWidthCompatible(800, 815)).toBe(true)
    expect(rowWidthCompatible(800, 785)).toBe(true)
  })

  test("rejects widths beyond tolerance", () => {
    expect(rowWidthCompatible(800, 820)).toBe(false)
    expect(rowWidthCompatible(800, 779)).toBe(false)
  })

  test("accepts unknown cached width", () => {
    expect(rowWidthCompatible(0, 800)).toBe(true)
  })
})
