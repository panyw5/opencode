import { describe, expect, test } from "bun:test"
import { hexToOklch } from "./color"
import { contentSurfaces, contrastRatio, opaqueColor } from "./contrast"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant } from "./resolve"
import { surfaceChromaLimit } from "./surfaces"
import type { HexColor } from "./types"

describe("built-in material hierarchy", () => {
  for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
    for (const mode of ["light", "dark"] as const) {
      test(`${id} ${mode} has distinct, restrained materials and legible content`, () => {
        const variant = theme[mode]
        const dark = mode === "dark"
        const tokens = resolveThemeVariant(variant, dark)
        const color = (key: string) => opaqueColor(tokens[key], tokens, tokens["background-base"] as HexColor)!
        const lightness = (key: string) => hexToOklch(color(key)).l
        if (variant.surfaces) {
          for (const [a, b, minimum] of [
            ["background-base", "background-stronger", 0.02],
            ["background-stronger", "surface-raised-base", 0.01],
            ["surface-inset-base", "surface-raised-base", 0.04],
            ["button-secondary-base", "button-secondary-hover", 0.01],
            ["button-secondary-hover", "button-secondary-active", 0.005],
          ] as const) {
            expect(Math.abs(lightness(a) - lightness(b)), `${a} vs ${b}`).toBeGreaterThanOrEqual(minimum)
          }
          expect(lightness("background-stronger")).toBeGreaterThan(lightness("background-base"))
          if (dark) expect(lightness("surface-raised-base")).toBeGreaterThan(lightness("background-stronger"))
          expect(tokens["background-stronger"]).toBe(variant.surfaces.canvas)
          if (!dark) expect(lightness("background-stronger")).toBeGreaterThan(0.89)

          for (const [a, b, gap] of [
            ["text-strong", "text-base", 0.03],
            ["text-base", "text-weak", 0.04],
            ["text-weak", "text-weaker", 0.02],
          ] as const) {
            expect((lightness(a) - lightness(b)) * (dark ? 1 : -1), `${a} vs ${b}`).toBeGreaterThanOrEqual(gap)
          }
          for (const [key, value] of Object.entries(tokens)) {
            if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) continue
            expect(hexToOklch(value as HexColor).c, key).toBeLessThanOrEqual(dark ? 0.149 : 0.174)
            const maximum = surfaceChromaLimit(key, dark)
            if (maximum !== undefined)
              expect(hexToOklch(value as HexColor).c, `${key} large-area chroma`).toBeLessThanOrEqual(maximum + 0.002)
          }
        } else {
          // Authored palettes own their material hierarchy instead of the generated profile.
          for (const key of ["background-base", "background-stronger", "surface-raised-base", "input-base"]) {
            expect(variant.overrides?.[key], `${id} ${mode} authored ${key}`).toBeDefined()
            expect(tokens[key]).toBe(variant.overrides![key])
          }
        }
        const foregrounds = Object.keys(tokens).filter(
          (key) =>
            key.startsWith("syntax-") ||
            /^markdown-(?!horizontal-rule)/.test(key) ||
            /^text-(base|strong|weak|weaker)$/.test(key),
        )
        for (const key of foregrounds) {
          for (const surface of contentSurfaces) {
            if (!tokens[surface]) continue
            expect(contrastRatio(color(key), color(surface)), `${key} on ${surface}`).toBeGreaterThanOrEqual(4.6)
          }
        }
        for (const kind of ["brand", "interactive", "success", "warning", "critical", "info"]) {
          for (const strength of ["base", "weak", "strong"]) {
            const foreground = `text-on-${kind}-${strength}`
            const surface = `surface-${kind}-${strength}`
            if (!tokens[foreground] || !tokens[surface]) continue
            expect(
              contrastRatio(color(foreground), color(surface)),
              `${foreground} on ${surface}`,
            ).toBeGreaterThanOrEqual(4.5)
          }
        }
        console.info(
          `[theme-materials-test] ${id} ${mode} authored=${!variant.surfaces} foregrounds=${foregrounds.length} surfaces=${contentSurfaces.filter((key) => !!tokens[key]).length}`,
        )
      })
    }
  }

  test("Catppuccin uses one official Latte and three distinct native dark bases", () => {
    const family = ["catppuccin", "catppuccin-frappe", "catppuccin-macchiato"]
    for (const id of family) {
      expect(DEFAULT_THEMES[id].light).toEqual(DEFAULT_THEMES.catppuccin.light)
      const tokens = resolveThemeVariant(DEFAULT_THEMES[id].light, false)
      expect(tokens["background-stronger"]).toBe("#eff1f5")
      expect(DEFAULT_THEMES[id].light.palette?.ink).toBe("#4c4f69")
      expect(hexToOklch(tokens["text-base"] as HexColor).l).toBeGreaterThan(0.39)
      expect(DEFAULT_THEMES[id].light.palette?.primary).toBe("#1e66f5")
    }
    for (const [id, base] of [
      ["catppuccin", "#1e1e2e"],
      ["catppuccin-frappe", "#303446"],
      ["catppuccin-macchiato", "#24273a"],
    ] as const) {
      expect(resolveThemeVariant(DEFAULT_THEMES[id].dark, true)["background-stronger"]).toBe(base)
    }
  })

  test("native theme backgrounds and foreground tints are not flattened into one palette", () => {
    for (const [id, base] of [
      ["nord", "#2e3440"],
      ["solarized", "#002b36"],
      ["rosepine", "#191724"],
      ["gruvbox", "#282828"],
      ["nightowl", "#011627"],
      ["cobalt2", "#193549"],
    ] as const) {
      expect(resolveThemeVariant(DEFAULT_THEMES[id].dark, true)["background-stronger"].toLowerCase()).toBe(base)
    }
    const matrix = resolveThemeVariant(DEFAULT_THEMES.matrix.dark, true)
    const jade = resolveThemeVariant(DEFAULT_THEMES["osaka-jade"].dark, true)
    expect(hexToOklch(matrix["text-base"] as HexColor).c).toBeGreaterThan(0.04)
    expect(hexToOklch(jade["text-base"] as HexColor).c).toBeGreaterThan(0.04)
    const gruvbox = resolveThemeVariant(DEFAULT_THEMES.gruvbox.dark, true)
    expect(hexToOklch(gruvbox["text-base"] as HexColor).c).toBeGreaterThan(0.04)
    expect(resolveThemeVariant(DEFAULT_THEMES.nord.dark, true)["syntax-string"]).toBe("#a3be8c")
  })

  test("pure-black themes retain their black shell without flattening panels", () => {
    for (const id of ["amoled", "vercel"]) {
      const tokens = resolveThemeVariant(DEFAULT_THEMES[id].dark, true)
      expect(tokens["background-base"]).toBe("#000000")
      expect(tokens["surface-raised-base"]).not.toBe("#000000")
    }
  })

  test("explicit surface and text overrides take precedence over material defaults", () => {
    const theme = DEFAULT_THEMES.nord.light
    const tokens = resolveThemeVariant(
      {
        ...theme,
        overrides: {
          "background-stronger": "#fdfcfb",
          "surface-raised-base": "#ffffff",
          "text-base": "#303030",
        },
      },
      false,
    )
    expect(tokens["background-stronger"]).toBe("#fdfcfb")
    expect(tokens["surface-raised-base"]).toBe("#ffffff")
    expect(tokens["text-base"]).toBe("#303030")
  })

  test("legacy custom themes do not opt into material or chroma normalization", () => {
    const theme = DEFAULT_THEMES.arc.light
    const tokens = resolveThemeVariant(
      { palette: theme.palette!, overrides: { "surface-brand-base": "#ff00ff" } },
      false,
    )
    expect(tokens["surface-brand-base"]).toBe("#ff00ff")
    expect(tokens["surface-panel"]).toBeUndefined()
  })

  test("unknown custom foreground expressions are not interpreted as hex colors", () => {
    const theme = DEFAULT_THEMES.nord.light
    const tokens = resolveThemeVariant({ ...theme, overrides: { "text-weak": "var(--external-foreground)" } }, false)
    expect(tokens["text-weak"]).toBe("var(--external-foreground)")
  })

  test("Material selected tabs use a gray teal tint rather than luminous cyan", () => {
    const tokens = resolveThemeVariant(DEFAULT_THEMES.material.light, false)
    const selected = tokens["surface-interactive-weak-hover"] as HexColor
    const tone = hexToOklch(selected)
    expect(tone.c).toBeLessThanOrEqual(0.027)
    expect(tone.l).toBeGreaterThan(0.88)
    expect(tone.l).toBeLessThan(0.94)
    expect(contrastRatio(tokens["text-strong"] as HexColor, selected)).toBeGreaterThanOrEqual(4.6)
    expect(selected).not.toBe("#99f1f8")
  })
})
