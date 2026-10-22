import { describe, expect, test } from "bun:test"
import { DEFAULT_THEMES } from "@opencode-ai/ui/theme/default-themes"
import { resolveThemeVariant } from "@opencode-ai/ui/theme/resolve"
import { themePreview } from "./theme-preview"

describe("theme card previews", () => {
  test("every bundled theme resolves self-contained light and dark previews", () => {
    for (const theme of Object.values(DEFAULT_THEMES)) {
      for (const mode of ["light", "dark"] as const) {
        const preview = themePreview(theme, mode)!
        const tokens = resolveThemeVariant(theme[mode], mode === "dark")
        expect(preview["--preview-sidebar"]).toBe(tokens["background-base"])
        expect(preview["--preview-session"]).toBe(tokens["background-stronger"])
        expect(preview["--preview-topbar"]).toBe(tokens["background-base"])
        expect(preview["--preview-popup"]).toBe(tokens["surface-raised-stronger-non-alpha"])
        for (const [previewKey, token] of [
          ["accent", "text-interactive-base"],
          ["selection", "surface-interactive-weak-hover"],
          ["keyword", "syntax-keyword"],
          ["string", "syntax-string"],
          ["function", "syntax-primitive"],
          ["input", "input-base"],
        ]) {
          expect(preview[`--preview-${previewKey}`]).toBe(tokens[token])
        }
        for (const value of Object.values(preview)) expect(value).toMatch(/^#[\da-f]{6,8}$/i)
        expect(themePreview(theme, mode)).toBe(preview)
      }
    }
  })

  test("Catppuccin previews share Latte but retain three distinct dark palettes", () => {
    const family = [
      DEFAULT_THEMES.catppuccin,
      DEFAULT_THEMES["catppuccin-frappe"],
      DEFAULT_THEMES["catppuccin-macchiato"],
    ]
    const light = family.map((t) => themePreview(t, "light"))
    expect(light[0]).toEqual(light[1])
    expect(light[1]).toEqual(light[2])
    const dark = family.map((t) => themePreview(t, "dark"))
    expect(new Set(dark.map((p) => p!["--preview-session"])).size).toBe(3)
    expect(new Set(dark.map((p) => p!["--preview-keyword"])).size).toBe(3)
  })

  test("syntax and accent colors distinguish themes that share neutral surfaces", () => {
    for (const mode of ["light", "dark"] as const) {
      const signatures = Object.values(DEFAULT_THEMES).map((theme) => {
        const p = themePreview(theme, mode)!
        return [p["--preview-session"], p["--preview-keyword"], p["--preview-string"], p["--preview-accent"]].join("/")
      })
      expect(new Set(signatures).size).toBeGreaterThanOrEqual(36)
    }
  })

  test("resolves custom token references without borrowing the selected theme", () => {
    const base = DEFAULT_THEMES.claude
    const theme = {
      ...base,
      light: {
        ...base.light,
        overrides: {
          ...base.light.overrides,
          "background-base": "#123456" as const,
          "surface-raised-stronger-non-alpha": "var(--background-base)" as const,
        },
      },
    }
    expect(themePreview(theme, "light")!["--preview-popup"]).toBe("#123456")
    expect(themePreview(theme, "dark")).not.toEqual(themePreview(theme, "light"))
  })
})
