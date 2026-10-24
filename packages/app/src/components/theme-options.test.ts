import { describe, expect, test } from "bun:test"
import { themeOptionCurrent, themeOptionIDs, themeOptionName, themeOptionTarget } from "./theme-options"

describe("theme flavor options", () => {
  const ids = ["catppuccin", "catppuccin-frappe", "catppuccin-macchiato", "nord"]
  test("light offers one Latte while dark retains three flavors", () => {
    expect(themeOptionIDs(ids, "light")).toEqual(["catppuccin", "nord"])
    expect(themeOptionIDs(ids, "dark")).toEqual(ids)
    expect(themeOptionName("catppuccin", "Catppuccin", "dark")).toBe("Catppuccin Mocha")
    for (const id of ids.slice(0, 3)) {
      expect(themeOptionName(id, id, "light")).toBe("Catppuccin Latte")
      expect(themeOptionCurrent(id, "light")).toBe("catppuccin")
      expect(themeOptionTarget("catppuccin", id, "light")).toBe(id)
      expect(themeOptionCurrent(id, "dark")).toBe(id)
    }
  })
  test("other themes and explicit dark flavor changes are untouched", () => {
    expect(themeOptionName("nord", "Nord", "light")).toBe("Nord")
    expect(themeOptionTarget("catppuccin", "nord", "light")).toBe("catppuccin")
    expect(themeOptionTarget("catppuccin-frappe", "catppuccin", "dark")).toBe("catppuccin-frappe")
  })
})
