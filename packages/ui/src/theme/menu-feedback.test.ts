import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { blend } from "./color"
import { contrastRatio, opaqueColor } from "./contrast"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant } from "./resolve"
import type { HexColor } from "./types"

// Project-specific visibility guards, not WCAG state contrast thresholds.
// Read the real CSS amounts so this check cannot test obsolete constants.
const feedback = ["context-menu", "dropdown-menu"].map((name) => {
  const css = readFileSync(new URL(`../components/${name}.css`, import.meta.url), "utf8")
  const amount = (state: string) => {
    const match = css.match(
      new RegExp(`--${name}-item-${state}-bg: color-mix\\(in srgb, var\\(--text-strong\\) ([\\d.]+)%, transparent\\)`),
    )
    if (!match) throw new Error(`Missing ${name} ${state} ink overlay`)
    return Number(match[1]) / 100
  }
  return { name, hover: amount("hover"), active: amount("active") }
})

describe("menu item feedback overlays", () => {
  for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
    for (const mode of ["light", "dark"] as const) {
      test(`${id} ${mode} has visible, legible menu feedback`, () => {
        const tokens = resolveThemeVariant(theme[mode], mode === "dark")
        const panel = opaqueColor(
          tokens["surface-raised-stronger-non-alpha"],
          tokens,
          tokens["background-base"] as HexColor,
        )
        if (!panel) throw new Error(`Unresolved panel: ${id} ${mode}`)
        const ink = opaqueColor(tokens["text-strong"], tokens, panel)
        if (!ink) throw new Error(`Unresolved menu ink: ${id} ${mode}`)

        for (const menu of feedback) {
          const hover = blend(ink, panel, menu.hover)
          const active = blend(ink, panel, menu.active)
          expect(contrastRatio(panel, hover), `${menu.name} hover`).toBeGreaterThanOrEqual(1.17)
          expect(contrastRatio(hover, active), `${menu.name} pressed`).toBeGreaterThanOrEqual(1.1)
          expect(contrastRatio(ink, hover), `${menu.name} hover text`).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(ink, active), `${menu.name} pressed text`).toBeGreaterThanOrEqual(4.5)
        }
      })
    }
  }
})
