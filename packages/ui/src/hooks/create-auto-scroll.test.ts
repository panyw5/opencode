import { describe, expect, test } from "bun:test"
import { autoScrollCanScroll, autoScrollDistanceFromBottom } from "./create-auto-scroll"

describe("auto-scroll cached geometry", () => {
  test("computes bottom distance without a DOM element", () => {
    expect(autoScrollDistanceFromBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 150 })).toBe(0)
    expect(autoScrollDistanceFromBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 150 })).toBe(50)
  })

  test("detects overflow from cached dimensions", () => {
    expect(autoScrollCanScroll({ scrollTop: 0, scrollHeight: 500, clientHeight: 400 })).toBe(true)
    expect(autoScrollCanScroll({ scrollTop: 0, scrollHeight: 400.5, clientHeight: 400 })).toBe(false)
  })
})
