import { describe, expect, test } from "bun:test"
import { hexToOklch } from "./color"
import { contrastRatio, opaqueColor } from "./contrast"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant } from "./resolve"
import type { HexColor } from "./types"

const tokens = resolveThemeVariant(DEFAULT_THEMES.chatgpt.dark, true)
const color = (key: string, background: HexColor = "#323232") => {
  const value = opaqueColor(tokens[key], tokens, background)
  expect(value, key).toBeDefined()
  return value!
}

describe("ChatGPT dark interaction feedback", () => {
  test("hover, press and selection retain distinct neutral gray levels", () => {
    // Usability guard, not a WCAG requirement for contrast between two states.
    for (const [from, to, minimum] of [
      ["background-base", "surface-base-hover", 0.06],
      ["surface-base-hover", "surface-base-active", 0.04],
      ["surface-base-hover", "surface-interactive-base", 0.07],
      ["surface-interactive-base", "surface-interactive-hover", 0.045],
      ["button-secondary-base", "button-secondary-hover", 0.05],
      ["button-secondary-hover", "button-secondary-active", 0.04],
      ["input-base", "input-hover", 0.05],
    ] as const) {
      const before = hexToOklch(color(from))
      const after = hexToOklch(color(to))
      expect(after.l - before.l, `${from} -> ${to}`).toBeGreaterThanOrEqual(minimum)
      expect(after.c, to).toBeLessThan(0.001)
    }
  })

  test("content remains readable on hover and pressed surfaces", () => {
    for (const key of ["surface-base-hover", "surface-base-active", "button-secondary-hover", "input-focus"]) {
      const background = color(key)
      for (const foreground of ["text-base", "text-weak", "text-weaker"]) {
        expect(contrastRatio(color(foreground, background), background), `${foreground}/${key}`).toBeGreaterThanOrEqual(
          4.5,
        )
      }
      expect(contrastRatio(color("icon-base", background), background), `icon-base/${key}`).toBeGreaterThanOrEqual(3)
    }
  })

  test("strong foregrounds and focus indicators remain visible on selected fills", () => {
    for (const key of ["surface-interactive-base", "surface-interactive-hover"]) {
      const background = color(key)
      expect(contrastRatio(color("text-strong", background), background), key).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(color("icon-strong-base", background), background), key).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(color("border-focus", background), background), key).toBeGreaterThanOrEqual(3)
    }
  })

  test("primary buttons keep dark text readable through all pointer states", () => {
    for (const key of ["button-primary-base", "button-primary-hover", "button-primary-active"]) {
      const background = color(key)
      expect(contrastRatio(color("button-primary-text", background), background), key).toBeGreaterThanOrEqual(4.5)
    }
  })
})
