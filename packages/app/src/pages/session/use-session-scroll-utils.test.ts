import { describe, expect, test } from "bun:test"
import { reachableTargetTop, returnedToLiveBottom, targetTop } from "./use-session-scroll-utils"

describe("returnedToLiveBottom", () => {
  const bottom = { gap: 0, threshold: 10, gesture: true, userScrolled: false, reading: true }

  test("restores follow at the physical bottom without a user displacement", () => {
    expect(returnedToLiveBottom(bottom)).toBe(true)
    expect(returnedToLiveBottom({ ...bottom, gap: 10 })).toBe(true)
  })

  test("does not resume while moving up or still away from the bottom", () => {
    expect(returnedToLiveBottom({ ...bottom, userScrolled: true })).toBe(false)
    expect(returnedToLiveBottom({ ...bottom, gap: 11 })).toBe(false)
  })

  test("does not take over programmatic scrolling or navigation", () => {
    expect(returnedToLiveBottom({ ...bottom, gesture: false })).toBe(false)
    expect(returnedToLiveBottom({ ...bottom, reading: false })).toBe(false)
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
