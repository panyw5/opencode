import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant } from "./resolve"

describe("hand-authored theme identity", () => {
  for (const [id, mode, shell, canvas, raised, text, brand] of [
    ["claude", "light", "#faf9f5", "#ffffff", "#ffffff", "#30302e", "#d97757"],
    ["aether", "light", "#F5F0E8", "#FFFCF8", "#FDFCF9", "#1A1612", "#c15f3c"],
    ["aether", "dark", "#1A1714", "#22201B", "#262320", "#E0D8C8", "#d97757"],
    ["arc", "light", "#F5F2FA", "#FFFFFF", "#FFFFFF", "#4A4458", "#6b46e5"],
    ["arc", "dark", "#2b2128", "#362c3a", "#3c3240", "#C8BED4", "#9b7ae8"],
    ["chatgpt", "light", "#ffffff", "#ffffff", "#ffffff", "#0d0d0d", "#0d0d0d"],
    ["chatgpt", "dark", "#323232", "#181818", "#282828", "#ffffff", "#ffffff"],
  ] as const) {
    test(`${id} ${mode} preserves its original materials and seed palette`, () => {
      const variant = DEFAULT_THEMES[id][mode]
      const tokens = resolveThemeVariant(variant, mode === "dark")
      expect(variant.surfaces).toBeUndefined()
      for (const [key, value] of [
        ["background-base", shell],
        ["background-stronger", canvas],
        ["surface-raised-base", raised],
      ] as const) {
        expect(tokens[key].toLowerCase(), key).toBe(value.toLowerCase())
      }
      // Contrast correction may adjust foreground lightness, not the authored source palette.
      expect((variant.overrides!["text-base"] ?? variant.palette!.ink).toLowerCase()).toBe(text.toLowerCase())
      expect(variant.palette!.primary.toLowerCase()).toBe(brand.toLowerCase())
      console.info(
        `[authored-theme-test] ${id} ${mode} shell=${tokens["background-base"]} canvas=${tokens["background-stronger"]}`,
      )
    })
  }

  test("Claude light keeps black primary controls and restores the original clay accent", () => {
    const tokens = resolveThemeVariant(DEFAULT_THEMES.claude.light, false)
    expect(tokens["button-primary-base"]).toBe("#141413")
    expect(tokens["button-primary-text"]).toBe("#faf9f5")
    expect(tokens["surface-brand-base"]).toBe("#c96442")
    expect(tokens["surface-interactive-weak-hover"]).toBe("#e8c3b5")
    expect(tokens["input-base"]).toBe("#ffffff")
  })

  test("ChatGPT dark matches the reference background layers", () => {
    const tokens = resolveThemeVariant(DEFAULT_THEMES.chatgpt.dark, true)
    for (const [key, value] of Object.entries({
      "background-base": "#323232",
      "background-weak": "#232323",
      "background-stronger": "#181818",
      "surface-raised-base": "#282828",
      "surface-raised-stronger-non-alpha": "#363636",
      "input-base": "#363636",
    } as const)) {
      expect(tokens[key].toLowerCase(), key).toBe(value.toLowerCase())
      console.info(`[chatgpt-background-test] ${key}=${tokens[key]}`)
    }
    const css = readFileSync(new URL("../styles/chatgpt.css", import.meta.url), "utf8")
    expect(css).toContain('html[data-theme="chatgpt"][data-color-scheme="dark"]')
    expect(css).toContain("background-color: var(--background-weak);")
    expect(css).toContain("background-color: var(--input-base);")
    expect(css).toContain("backdrop-filter: none;")
  })

  test("Aether and Arc keep their dedicated component materials", () => {
    const aether = readFileSync(new URL("../styles/aether.css", import.meta.url), "utf8")
    const arc = readFileSync(new URL("../styles/arc.css", import.meta.url), "utf8")
    expect(aether).toContain("background-color: #FDF1EB;")
    expect(aether).toContain("background-color: #1E1B18 !important;")
    expect(arc).toContain("--sidebar-card-bg: #4a3d47;")
    expect(arc).toContain("--sidebar-card-bg: #6c5d79;")
    expect(arc).toContain("--dock-shell-bg: #221c22;")
    expect(arc).toContain("--dock-shell-bg: #f6f1fa;")
  })
})
