import { describe, expect, test } from "bun:test"
import { stashMotionGeometry } from "./sidebar-panel-stash-motion"

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height }) as DOMRect

describe("sidebar stash motion", () => {
  test("moves source center onto the stash button center", () => {
    expect(stashMotionGeometry(rect(320, 80, 800, 600), rect(12, 72, 40, 40))).toEqual({
      x: -688,
      y: -288,
      scale: 0.05,
    })
  })

  test("caps the terminal scale for unusually small and large sources", () => {
    expect(stashMotionGeometry(rect(0, 0, 20, 20), rect(0, 0, 40, 40)).scale).toBe(0.18)
    expect(stashMotionGeometry(rect(0, 0, 4000, 4000), rect(0, 0, 40, 40)).scale).toBe(0.035)
  })
})
