import { describe, expect, test } from "bun:test"
import { railTooltipPlacement } from "./rail-tooltip"

describe("railTooltipPlacement", () => {
  test("defaults to right on desktop and bottom on mobile", () => {
    expect(railTooltipPlacement({})).toBe("right")
    expect(railTooltipPlacement({ mobile: true })).toBe("bottom")
  })

  test("honors explicit placement over mobile default", () => {
    expect(railTooltipPlacement({ placement: "bottom" })).toBe("bottom")
    expect(railTooltipPlacement({ mobile: true, placement: "right" })).toBe("right")
  })
})
