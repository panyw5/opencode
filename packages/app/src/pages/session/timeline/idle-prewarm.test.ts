import { expect, test } from "bun:test"
import { isLongMathText, pickIdlePrewarmRow } from "./idle-prewarm"

test("prewarms only the nearest eligible row above the viewport", () => {
  const rows = [
    { index: 1, start: 0, size: 100 },
    { index: 2, start: 150, size: 100 },
    { index: 3, start: 300, size: 100 },
    { index: 4, start: 450, size: 100 },
  ]
  expect(pickIdlePrewarmRow(rows, 450, 300, (row) => row.index !== 3)?.index).toBe(2)
  expect(pickIdlePrewarmRow(rows, 450, 100, () => true)?.index).toBe(3)
  expect(pickIdlePrewarmRow(rows, 450, 20, () => true)).toBeUndefined()
})

test("limits prewarming to long display-math content", () => {
  expect(isLongMathText("x".repeat(1_200))).toBe(false)
  expect(isLongMathText("x".repeat(1_190) + "$$x$$")).toBe(false)
  expect(isLongMathText("x".repeat(1_200) + "$$x$$")).toBe(true)
  expect(isLongMathText("x".repeat(1_200) + "\\[x\\]")).toBe(true)
})
