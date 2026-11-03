import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { blend } from "./color"
import { contrastRatio, opaqueColor } from "./contrast"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant } from "./resolve"
import type { HexColor } from "./types"

const css = readFileSync(new URL("../../../app/src/index.css", import.meta.url), "utf8")
const row = css.slice(css.indexOf('  [data-component="sidebar-session"] {'), css.indexOf("  /* Segmented toolbar"))
const amounts = ["active-bg-top", "active-bg-bottom", "active-hover-bg"].map((state) => {
  const match = row.match(
    new RegExp(
      `--sidebar-session-${state}: color-mix\\(in srgb, var\\(--text-strong\\) (\\d+)%, var\\(--background-stronger\\)\\)`,
    ),
  )
  if (!match) throw new Error(`Missing theme-native sidebar ${state}`)
  return { state, alpha: Number(match[1]) / 100 }
})

describe("theme-native sidebar session selection", () => {
  test("default selection and hover have no fixed brown palette", () => {
    expect(row).toContain("--sidebar-session-accent: var(--text-strong);")
    expect(row).not.toMatch(/#[\da-f]{3,8}/i)
    expect(css).not.toContain("#c98a6d")
    expect(css).not.toContain("#34302b")
    expect(css).toContain(
      '  [data-component="sidebar-session"][data-active="true"] [data-slot="session-meta"] span {\n    color: var(--text-base) !important;',
    )
  })

  for (const [id, theme] of Object.entries(DEFAULT_THEMES)) {
    // Arc has separately authored mauve sidebar chrome, exercised in CDP.
    if (id === "arc") continue
    for (const mode of ["light", "dark"] as const) {
      test(`${id} ${mode} has legible, visible native selection`, () => {
        const tokens = resolveThemeVariant(theme[mode], mode === "dark")
        const panel = opaqueColor(tokens["background-stronger"], tokens, tokens["background-base"] as HexColor)!
        const title = opaqueColor(tokens["text-strong"], tokens, panel)!
        const meta = opaqueColor(tokens["text-base"], tokens, panel)!
        for (const { state, alpha } of amounts) {
          const fill = blend(title, panel, alpha)
          expect(contrastRatio(title, fill), `${state} title`).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(meta, fill), `${state} metadata`).toBeGreaterThanOrEqual(4.5)
          expect(contrastRatio(panel, fill), `${state} visibility`).toBeGreaterThanOrEqual(1.17)
        }
      })
    }
  }
})
