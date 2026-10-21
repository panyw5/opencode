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
        for (const value of Object.values(preview)) expect(value).toMatch(/^#[\da-f]{6,8}$/i)
        expect(themePreview(theme, mode)).toBe(preview)
      }
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
