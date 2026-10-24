import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { DEFAULT_THEMES } from "./default-themes"
import { hexToOklch, hexToRgb } from "./color"
import { resolveThemeVariant } from "./resolve"
import { opaqueColor } from "./contrast"
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
    for (const [fill, foreground] of [
      ["#50372c", "#ffffff"],
      ["#e8cbb9", "#000000"],
    ] as const) {
      const theme = DEFAULT_THEMES.claude.light
      const tokens = resolveThemeVariant(
        {
          ...theme,
          overrides: {
            ...theme.overrides,
            "surface-brand-hover": fill,
          },
        },
        false,
      )
      expect(tokens["surface-brand-hover"]).toBe(fill)
      expect(tokens["icon-on-brand-hover"]).toBe(foreground)
      expect(tokens["text-on-brand-strong"]).toBe(foreground)
    }
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

describe("floating surface foreground colors", () => {
  test("theme-native foregrounds are preferred when they meet contrast", () => {
    const tokens = resolveThemeVariant(DEFAULT_THEMES.gruvbox.light, false)

    expect(tokens["text-on-float-base"]).toBe(tokens["text-invert-strong"])
    expect(tokens["text-on-float-base-hover"]).toBe(tokens["text-invert-strong"])
  })

  test("Tailwind utilities expose both floating foreground tokens", () => {
    const css = readFileSync(new URL("../styles/tailwind/colors.css", import.meta.url), "utf8")

    expect(css).toContain("--color-text-on-float-base: var(--text-on-float-base);")
    expect(css).toContain("--color-text-on-float-base-hover: var(--text-on-float-base-hover);")
  })

  test("all bundled theme tooltips keep readable foreground contrast", () => {
    for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveThemeVariant(theme[mode], mode === "dark")
        const label = `${id} ${mode}`

        expect(
          contrast(tokens["text-on-float-base"] as HexColor, tokens["surface-float-base"] as HexColor),
          `${label} tooltip contrast`,
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrast(tokens["text-on-float-base-hover"] as HexColor, tokens["surface-float-base-hover"] as HexColor),
          `${label} project tooltip contrast`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test("translucent and variable surface overrides use their composited background", () => {
    const theme = DEFAULT_THEMES.opencode
    const translucent = resolveThemeVariant(
      {
        ...theme.light,
        overrides: { ...theme.light.overrides, "surface-float-base": "#11111180" },
      },
      false,
    )
    const variable = resolveThemeVariant(
      {
        ...theme.light,
        overrides: { ...theme.light.overrides, "surface-float-base-hover": "var(--surface-base)" },
      },
      false,
    )

    for (const [tokens, surface, foreground] of [
      [translucent, "surface-float-base", "text-on-float-base"],
      [variable, "surface-float-base-hover", "text-on-float-base-hover"],
    ] as const) {
      const fill = opaqueColor(tokens[surface], tokens, tokens["background-base"] as HexColor)!
      expect(contrast(tokens[foreground] as HexColor, fill)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test("shortcut text inherits scoped tooltip foreground overrides", () => {
    const css = readFileSync(new URL("../components/tooltip.css", import.meta.url), "utf8")
    expect(css).toMatch(/\[data-slot="tooltip-keybind-key"\]\s*\{\s*color: inherit;/)
  })

  test("unknown custom surface expressions retain the fallback foreground", () => {
    const theme = DEFAULT_THEMES.opencode
    const tokens = resolveThemeVariant(
      {
        ...theme.light,
        overrides: { ...theme.light.overrides, "surface-float-base": "var(--external-surface)" },
      },
      false,
    )
    expect(tokens["text-on-float-base"]).toBe(tokens["text-invert-strong"])
  })
})
