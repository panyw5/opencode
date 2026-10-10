import { expect, test } from "bun:test"
import { shouldTrackSelectionScroll } from "./session-selection-toolbar"

test("selection toolbar ignores scrolls without a selection or visible toolbar", () => {
  expect(shouldTrackSelectionScroll(false, false)).toBe(false)
  expect(shouldTrackSelectionScroll(false, true)).toBe(true)
  expect(shouldTrackSelectionScroll(true, false)).toBe(true)
})
