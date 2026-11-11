import { describe, expect, test } from "bun:test"
import { CODE_PADDING_TOP, LINE_HEIGHT, centeredScrollTop, maxColumns, visibleRange } from "../src/viewport"

describe("large-file viewport", () => {
  test("mounts a bounded window at the top and middle of 100,000 lines", () => {
    for (const top of [0, 50000 * LINE_HEIGHT, 99999 * LINE_HEIGHT]) {
      const { start, end } = visibleRange(100000, top, 600)
      expect(end - start).toBeLessThanOrEqual(55)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeLessThanOrEqual(100000)
      const target = Math.min(99999, Math.floor(Math.max(0, top - CODE_PADDING_TOP) / LINE_HEIGHT))
      expect(start).toBeLessThanOrEqual(target)
      expect(end).toBeGreaterThan(target)
    }
  })

  test("clamps stale scroll positions after shrinking a file", () => {
    expect(visibleRange(3, 2000000, 600)).toEqual({ start: 2, end: 3 })
    expect(visibleRange(0, 0, 0)).toEqual({ start: 0, end: 0 })
    expect(visibleRange(1, -100, 0)).toEqual({ start: 0, end: 1 })
  })

  test("centers an unmounted paused line without querying the DOM", () => {
    const top = centeredScrollTop(90000, 600)
    const { start, end } = visibleRange(100000, top, 600)
    expect(start).toBeLessThan(89999)
    expect(end).toBeGreaterThan(89999)
    expect(CODE_PADDING_TOP + (90000 - 0.5) * LINE_HEIGHT - top).toBe(300)
    expect(centeredScrollTop(1, 600)).toBe(0)
  })

  test("reserves space for offscreen long lines and tab stops", () => {
    expect(maxColumns(["", "abc", "\tab\tc"])).toBe(9)
    expect(maxColumns(["a\tb", "1234567890"])).toBe(10)
    expect(maxColumns([])).toBe(0)
  })
})
