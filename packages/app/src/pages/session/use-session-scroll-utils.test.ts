import { describe, expect, test } from "bun:test"
import { atPhysicalBottom, physicalScrollGap, reachableTargetTop, targetTop } from "./use-session-scroll-utils"

describe("physical bottom", () => {
  test("an unmounted or hidden viewport is not a physical bottom", () => {
    expect(atPhysicalBottom({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })).toBe(false)
    expect(atPhysicalBottom({ scrollTop: 100, scrollHeight: 100, clientHeight: 0 })).toBe(false)
  })

  test("a visible short conversation can be at the physical bottom", () => {
    expect(atPhysicalBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 400 })).toBe(true)
  })

  test("uses actual geometry rather than an underestimated cached extent", () => {
    const cached = { scrollTop: 400, scrollHeight: 500, clientHeight: 100 }
    const physical = { scrollTop: 400, scrollHeight: 900, clientHeight: 100 }
    expect(physicalScrollGap(cached)).toBe(0)
    expect(atPhysicalBottom(cached)).toBe(true)
    expect(physicalScrollGap(physical)).toBe(400)
    expect(atPhysicalBottom(physical)).toBe(false)
  })
})

describe("targetTop", () => {
  test("accounts for sticky inset while preserving scroll offset", () => {
    expect(
      targetTop({
        itemTop: 260,
        rootTop: 100,
        scrollTop: 700,
        inset: 48,
      }),
    ).toBe(812)
  })

  test("clamps negative targets to the top of the scroller", () => {
    expect(
      targetTop({
        itemTop: 80,
        rootTop: 100,
        scrollTop: 10,
        inset: 48,
      }),
    ).toBe(0)
  })
})

describe("reachableTargetTop", () => {
  test("keeps an ordinary message target unchanged", () => {
    expect(
      reachableTargetTop({
        itemTop: 500,
        rootTop: 100,
        scrollTop: 200,
        inset: 40,
        scrollHeight: 2_000,
        clientHeight: 800,
      }),
    ).toBe(560)
  })

  test("clamps a target near the end to the maximum scroll position", () => {
    expect(
      reachableTargetTop({
        itemTop: 900,
        rootTop: 100,
        scrollTop: 1_000,
        inset: 0,
        scrollHeight: 2_000,
        clientHeight: 800,
      }),
    ).toBe(1_200)
  })
})
