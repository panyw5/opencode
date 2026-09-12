import { describe, expect, test } from "bun:test"
import { timelineMessageScrollTop, timelineScrollOwner } from "./scroll-owner"

describe("timeline scroll ownership", () => {
  test("navigation excludes all other scroll owners regardless of bottom/history state", () => {
    for (const bottom of [false, true]) {
      for (const history of [false, true]) {
        expect(timelineScrollOwner({ navigating: true, bottom, history })).toBe("navigation")
      }
    }
  })
  test("normal bottom, history and reading anchoring resume after navigation releases ownership", () => {
    expect(timelineScrollOwner({ navigating: false, bottom: true, history: true })).toBe("bottom")
    expect(timelineScrollOwner({ navigating: false, bottom: false, history: true })).toBe("history")
    expect(timelineScrollOwner({ navigating: false, bottom: false, history: false })).toBe("reading")
  })
})

describe("message navigation scroll goal", () => {
  test("reveal and measurement commits align to the top, not the row center", () => {
    expect(timelineMessageScrollTop({ rowStart: 5_000, totalSize: 10_000, viewportHeight: 800, inset: 40 })).toBe(4_960)
  })
  test("a measured height change above the target updates the goal in the same virtual coordinates", () => {
    const before = timelineMessageScrollTop({ rowStart: 5_000, totalSize: 10_000, viewportHeight: 800, inset: 0 })
    const after = timelineMessageScrollTop({ rowStart: 6_177, totalSize: 11_177, viewportHeight: 800, inset: 0 })
    expect(after - before).toBe(1_177)
  })
  test("keeps near-bottom targets reachable as the total virtual height changes", () => {
    expect(timelineMessageScrollTop({ rowStart: 9_700, totalSize: 10_000, viewportHeight: 800, inset: 0 })).toBe(9_200)
    expect(timelineMessageScrollTop({ rowStart: 9_700, totalSize: 12_000, viewportHeight: 800, inset: 0 })).toBe(9_700)
    expect(timelineMessageScrollTop({ rowStart: 0, totalSize: 100, viewportHeight: 800, inset: 40 })).toBe(0)
  })
})
