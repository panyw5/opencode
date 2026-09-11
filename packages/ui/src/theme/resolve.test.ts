import { describe, expect, test } from "bun:test"
import { DEFAULT_THEMES } from "./default-themes"
import { hexToOklch, hexToRgb } from "./color"
import { resolveThemeVariant } from "./resolve"
import type { HexColor } from "./types"

function luminance(hex: HexColor) {
  const rgb = hexToRgb(hex)
  const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4))
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b)
}

function contrast(a: HexColor, b: HexColor) {
  const light = Math.max(luminance(a), luminance(b))
  const dark = Math.min(luminance(a), luminance(b))
  return (light + 0.05) / (dark + 0.05)
}

function delta(a: HexColor, b: HexColor) {
  return Math.abs(hexToOklch(a).l - hexToOklch(b).l)
}

describe("primary button interaction colors", () => {
  test("brand foreground colors follow overridden brand surfaces", () => {
    const tokens = resolveThemeVariant(DEFAULT_THEMES.claude.light, false)

    expect(tokens["surface-brand-hover"]).toBe("#b85a39")
    expect(tokens["icon-on-brand-hover"]).toBe("#ffffff")
    expect(tokens["text-on-brand-strong"]).toBe("#ffffff")
  })

  test("Claude light has a clearly visible hover state", () => {
    const theme = DEFAULT_THEMES.claude
    const tokens = resolveThemeVariant(theme.light, false)
    const base = tokens["button-primary-base"] as HexColor
    const hover = tokens["button-primary-hover"] as HexColor

    expect(delta(base, hover)).toBeGreaterThanOrEqual(0.15)
    expect(luminance(hover)).toBeGreaterThan(luminance(base))
  })

  test("all bundled themes keep primary interaction states visible and legible", () => {
    for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveThemeVariant(theme[mode], mode === "dark")
        const base = tokens["button-primary-base"] as HexColor
        const hover = tokens["button-primary-hover"] as HexColor
        const active = tokens["button-primary-active"] as HexColor
        const text = tokens["button-primary-text"] as HexColor
        const label = `${id} ${mode}`

        expect(delta(base, hover), `${label} hover`).toBeGreaterThanOrEqual(0.1)
        expect(delta(base, active), `${label} active`).toBeGreaterThanOrEqual(0.15)
        expect(delta(hover, active), `${label} hover to active`).toBeGreaterThanOrEqual(0.04)
        expect(contrast(hover, text), `${label} hover contrast`).toBeGreaterThanOrEqual(4.5)
        expect(contrast(active, text), `${label} active contrast`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})
