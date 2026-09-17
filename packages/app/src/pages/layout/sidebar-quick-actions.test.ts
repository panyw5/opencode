import { describe, expect, test } from "bun:test"
import { visibleSidebarActionCount } from "./sidebar-quick-actions"

describe("visibleSidebarActionCount", () => {
  test("shows every action when all fixed-width buttons fit", () => {
    expect(visibleSidebarActionCount(258, 5)).toBe(5)
  })

  test("progressively moves actions into the overflow menu", () => {
    expect(visibleSidebarActionCount(257, 5)).toBe(3)
    expect(visibleSidebarActionCount(216, 5)).toBe(3)
    expect(visibleSidebarActionCount(215, 5)).toBe(2)
    expect(visibleSidebarActionCount(173, 5)).toBe(1)
    expect(visibleSidebarActionCount(131, 5)).toBe(0)
  })

  test("keeps the only secondary action in overflow when the row is narrow", () => {
    expect(visibleSidebarActionCount(89, 1)).toBe(0)
    expect(visibleSidebarActionCount(90, 1)).toBe(1)
  })

  test("handles empty and invalid measurements", () => {
    expect(visibleSidebarActionCount(300, 0)).toBe(0)
    expect(visibleSidebarActionCount(0, 5)).toBe(0)
  })
})
