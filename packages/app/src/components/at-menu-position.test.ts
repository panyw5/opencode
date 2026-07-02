import { describe, expect, test } from "bun:test"
import { resolveAtMenuLeft } from "./at-menu-position"

describe("at-menu position", () => {
  test("keeps the menu to the right when there is enough space", () => {
    expect(
      resolveAtMenuLeft({
        anchorLeft: 120,
        boxWidth: 600,
        menuWidth: 280,
      }),
    ).toBe(120)
  })

  test("moves the menu to the left of the caret near the right edge", () => {
    expect(
      resolveAtMenuLeft({
        anchorLeft: 520,
        boxWidth: 600,
        menuWidth: 280,
      }),
    ).toBe(240)
  })
})
