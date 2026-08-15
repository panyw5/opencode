import { describe, expect, test } from "bun:test"
import { shouldFinishInitialScroll, shouldRefreshStaleSession } from "./session-switch-performance"

describe("session switch performance", () => {
  test("skips a stale refresh when the initial sync refreshed the cache", () => {
    expect(shouldRefreshStaleSession({ wasStale: true, refreshedAt: 900, now: 1_000, ttl: 500 })).toBe(false)
  })

  test("refreshes a cache that remains stale after the initial sync", () => {
    expect(shouldRefreshStaleSession({ wasStale: true, refreshedAt: 100, now: 1_000, ttl: 500 })).toBe(true)
    expect(shouldRefreshStaleSession({ wasStale: true, now: 1_000, ttl: 500 })).toBe(true)
  })

  test("does not refresh data that was already fresh on entry", () => {
    expect(shouldRefreshStaleSession({ wasStale: false, refreshedAt: 100, now: 1_000, ttl: 500 })).toBe(false)
  })

  test("finishes initial scrolling after three stable frames", () => {
    expect(shouldFinishInitialScroll({ stableFrames: 2, now: 100, deadline: 1_000 })).toBe(false)
    expect(shouldFinishInitialScroll({ stableFrames: 3, now: 100, deadline: 1_000 })).toBe(true)
  })

  test("retains the deadline fallback for unstable layouts", () => {
    expect(shouldFinishInitialScroll({ stableFrames: 0, now: 1_000, deadline: 1_000 })).toBe(true)
  })
})
