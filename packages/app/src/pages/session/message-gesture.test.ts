import { describe, expect, test } from "bun:test"
import {
  accumulateSmoothWheelTarget,
  normalizeWheelDelta,
  shouldMarkBoundaryGesture,
  shouldSmoothDiscreteWheel,
  smoothWheelFramePosition,
} from "./message-gesture"

describe("normalizeWheelDelta", () => {
  test("converts line mode to px", () => {
    expect(normalizeWheelDelta({ deltaY: 3, deltaMode: 1, rootHeight: 500 })).toBe(120)
  })

  test("converts page mode to container height", () => {
    expect(normalizeWheelDelta({ deltaY: -1, deltaMode: 2, rootHeight: 600 })).toBe(-600)
  })

  test("keeps pixel mode unchanged", () => {
    expect(normalizeWheelDelta({ deltaY: 16, deltaMode: 0, rootHeight: 600 })).toBe(16)
  })
})

describe("shouldMarkBoundaryGesture", () => {
  test("marks when nested scroller cannot scroll", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 300,
      }),
    ).toBe(true)
  })

  test("marks when scrolling beyond top boundary", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: -40,
        scrollTop: 10,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  test("marks when scrolling beyond bottom boundary", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 50,
        scrollTop: 580,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  test("does not mark when nested scroller can consume movement", () => {
    expect(
      shouldMarkBoundaryGesture({
        delta: 20,
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe(false)
  })
})

describe("smooth discrete wheel", () => {
  test("smooths a traditional macOS wheel notch", () => {
    expect(
      shouldSmoothDiscreteWheel({
        deltaX: 0,
        deltaY: 100,
        deltaMode: 0,
        wheelDeltaY: -120,
        macOS: true,
      }),
    ).toBe(true)
  })

  test("leaves precise trackpad input native", () => {
    expect(
      shouldSmoothDiscreteWheel({
        deltaX: 0.4,
        deltaY: 6.25,
        deltaMode: 0,
        wheelDeltaY: -7.5,
        macOS: true,
      }),
    ).toBe(false)
  })

  test("leaves non-macOS platforms native", () => {
    const base = { deltaX: 0, deltaY: 3, deltaMode: 1, wheelDeltaY: -120 }
    expect(shouldSmoothDiscreteWheel({ ...base, macOS: false })).toBe(false)
  })

  test("accumulates and clamps the target", () => {
    expect(accumulateSmoothWheelTarget({ current: 200, delta: 120, max: 1000 })).toBe(320)
    expect(accumulateSmoothWheelTarget({ current: 200, target: 500, delta: 700, max: 1000 })).toBe(1000)
    expect(accumulateSmoothWheelTarget({ current: 200, target: 100, delta: -500, max: 1000 })).toBe(0)
  })

  test("eases toward the target without overshooting after a long frame", () => {
    const normal = smoothWheelFramePosition({ current: 0, target: 100, elapsed: 16 })
    const stalled = smoothWheelFramePosition({ current: 0, target: 100, elapsed: 200 })
    expect(normal).toBeGreaterThan(0)
    expect(normal).toBeLessThan(100)
    expect(stalled).toBeGreaterThan(normal)
    expect(stalled).toBeLessThan(100)
  })
})
