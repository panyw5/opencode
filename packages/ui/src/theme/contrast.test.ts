import { describe, expect, test } from "bun:test"
import { contentSurfaces, contrastRatio, opaqueColor, readableColor } from "./contrast"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant } from "./resolve"
import type { HexColor } from "./types"

describe("theme content contrast", () => {
  test("all built-in variants keep small text and enabled icons readable on content surfaces", () => {
    for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveThemeVariant(theme[mode], mode === "dark")
        const background = tokens["background-base"] as HexColor
        for (const surface of contentSurfaces) {
          if (!tokens[surface]) continue
          const fill = opaqueColor(tokens[surface], tokens, background)
          expect(fill, `${id} ${mode} ${surface}`).toBeDefined()
          for (const key of [
            "text-base",
            "text-strong",
            "text-weak",
            "text-weaker",
            "icon-base",
            "icon-weak-base",
            "icon-strong-base",
            "icon-interactive-base",
            "markdown-link",
            "markdown-code",
            "text-success-base",
            "text-warning-base",
            "text-critical-base",
            "text-info-base",
          ]) {
            const color = opaqueColor(tokens[key], tokens, background)!
            expect(contrastRatio(color, fill!), `${id} ${mode} ${key} on ${surface}`).toBeGreaterThanOrEqual(
              key.startsWith("icon") ? 3.1 : 4.6,
            )
          }
        }
      }
    }
  })

  test("readable colors are preserved exactly", () => {
    expect(readableColor("#3c3836", ["#fbf1c7"], 4.5)).toBe("#3c3836")
    expect(readableColor("#ebdbb2", ["#282828"], 4.5)).toBe("#ebdbb2")
  })

  test("resolves alpha and variable colors without following cycles", () => {
    expect(opaqueColor("#0008", {}, "#ffffff")).toBe("#777777")
    expect(opaqueColor("rgba(0, 0, 0, 0.5)", {}, "#ffffff")).toBe("#808080")
    expect(opaqueColor("var(--a)", { a: "#ffffff80" }, "#000000")).toBe("#808080")
    expect(opaqueColor("var(--a)", { a: "var(--a)" }, "#000000")).toBeUndefined()
    expect(opaqueColor("color-mix(in oklab, black, white)", {}, "#ffffff")).toBeUndefined()
  })

  test("colored avatar initials remain readable in every variant", () => {
    for (const theme of Object.values(DEFAULT_THEMES)) {
      for (const mode of ["light", "dark"] as const) {
        const tokens = resolveThemeVariant(theme[mode], mode === "dark")
        for (const name of ["pink", "mint", "orange", "purple", "cyan", "lime"]) {
          expect(
            contrastRatio(tokens[`avatar-text-${name}`] as HexColor, tokens[`avatar-background-${name}`] as HexColor),
          ).toBeGreaterThanOrEqual(4.6)
        }
      }
    }
  })
})
