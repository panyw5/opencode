import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { contrastRatio } from "../theme/contrast"
import type { HexColor } from "../theme/types"

const css = readFileSync(new URL("./arc.css", import.meta.url), "utf8")

describe("Arc chrome contrast overrides", () => {
  test("light sidebar keycaps use a dark foreground on their light face", () => {
    const foreground = "#352d3c" as HexColor
    const observedFills = ["#c6c0cf", "#bbb6c5"] as HexColor[]

    expect(css).toContain("--surface-base: #f6f1fa;")
    expect(css).toContain("--color-surface-base: #f6f1fa;")
    expect(css).toContain("--text-weak: #352d3c;")
    expect(css).toContain("--color-text-weak: #352d3c;")
    for (const fill of observedFills) {
      expect(contrastRatio(foreground, fill)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test("dark sidebar text ramp meets AA on panel, interaction, and avatar fills", () => {
    const fills = ["#584e62", "#62586b", "#5d4f59", "#4a4150", "#645a6d"] as HexColor[]
    const ramp = ["#ffffff", "#e8e0f0", "#e1d4eb", "#e0d3e8"] as HexColor[]

    for (const [token, value] of Object.entries({
      "text-strong": "#ffffff",
      "text-stronger": "#ffffff",
      "text-base": "#e8e0f0",
      "text-weak": "#e1d4eb",
      "text-weaker": "#e0d3e8",
    })) {
      expect(css).toContain(`--${token}: ${value};`)
      expect(css).toContain(`--color-${token}: ${value};`)
    }
    for (const foreground of ramp) {
      for (const fill of fills) {
        expect(contrastRatio(foreground, fill), `${foreground} on ${fill}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test("dark sidebar icon ramp stays distinguishable on interaction and avatar fills", () => {
    const fills = ["#584e62", "#62586b", "#5d4f59", "#4a4150", "#645a6d"] as HexColor[]
    const ramp = ["#bfb3cc"] as HexColor[]

    for (const token of ["icon-base", "icon-weak-base", "icon-weak-active", "icon-weak-selected", "icon-weak-focus"]) {
      expect(css).toContain(`--${token}: #bfb3cc;`)
      expect(css).toContain(`--color-${token}: #bfb3cc;`)
    }
    for (const foreground of ramp) {
      for (const fill of fills) {
        expect(contrastRatio(foreground, fill), `${foreground} on ${fill}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
