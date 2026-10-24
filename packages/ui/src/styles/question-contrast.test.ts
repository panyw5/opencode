import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { blend } from "../theme/color"
import { contrastRatio } from "../theme/contrast"
import { DEFAULT_THEMES } from "../theme/default-themes"
import { resolveThemeVariant } from "../theme/resolve"
import type { HexColor } from "../theme/types"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("question foreground contrast", () => {
  test("custom placeholders inherit the state-aware input color without fading", () => {
    const css = read("../components/message-part.css")
    const input = css.slice(css.indexOf('  [data-slot="question-custom-input"] {'))
    expect(input).toMatch(/&::placeholder\s*\{\s*color: currentColor;\s*opacity: 1;/)
  })

  test("Claude light uses white text on its darkened selection", () => {
    const css = read("./claude.css")
    const light = resolveThemeVariant(DEFAULT_THEMES.claude.light, false)
    const fill = blend(light["surface-interactive-base"] as HexColor, "#000000", 0.82)
    expect(contrastRatio("#ffffff", fill)).toBeGreaterThanOrEqual(4.5)
    expect(css).toMatch(/\[data-slot="question-custom-input"\]\s*\{\s*color: #ffffff;/)
  })

  test("Claude dark swaps hover and selection fills with readable paired foregrounds", () => {
    const css = read("./claude.css")
    const dark = resolveThemeVariant(DEFAULT_THEMES.claude.dark, true)
    const hover = dark["surface-interactive-base"] as HexColor
    const picked = blend(dark["surface-interactive-weak"] as HexColor, hover, 0.4)
    expect(contrastRatio(dark["text-on-interactive-base"] as HexColor, hover)).toBeGreaterThanOrEqual(4.5)
    for (const token of ["text-base", "text-strong"]) {
      expect(contrastRatio(dark[token] as HexColor, picked)).toBeGreaterThanOrEqual(4.5)
    }
    const overrides = css.slice(
      css.indexOf('html[data-theme="claude"][data-color-scheme="dark"] [data-component="dock-prompt"]'),
    )
    expect(overrides).toContain(
      ']:hover:not([data-picked="true"]):not([data-focused="true"]):not(:active) {\n    background-color: var(--surface-interactive-base);',
    )
    expect(overrides).toContain(
      '][data-picked="true"] {\n    background-color: color-mix(in srgb, var(--surface-interactive-weak) 40%, var(--surface-interactive-base));',
    )
  })

  test("Claude dark custom answers share the ordinary option selection styles", () => {
    const css = read("./claude.css")
    expect(css).not.toContain('[data-custom="true"]')
  })

  test("Arc and Aether include custom inputs in their option foreground overrides", () => {
    for (const theme of ["arc", "aether"]) {
      const css = read(`./${theme}.css`)
      const groups = css.match(/\[data-slot="option-description"\],\s*\[data-slot="question-custom-input"\]/g)
      expect(groups?.length).toBe(theme === "arc" ? 2 : 1)
    }
  })
})
