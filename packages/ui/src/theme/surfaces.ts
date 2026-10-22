import { blend, hexToOklch, oklchToHex } from "./color"
import type { HexColor, ResolvedTheme, ThemeSurfaces } from "./types"

// Explicit material colors keep elevation independent of the semantic accent palette.
export function surfaceTokens(surfaces: ThemeSurfaces, ink: HexColor, isDark: boolean): ResolvedTheme {
  const { shell, canvas, raised, inset } = surfaces
  const tone = hexToOklch(ink)
  const body = isDark ? Math.min(tone.l, 0.91) : Math.max(tone.l, 0.28)
  const text = (offset: number) => oklchToHex({ ...tone, l: body + offset, c: Math.min(tone.c, 0.065) })
  const hover = blend(isDark ? inset : ink, raised, isDark ? 0.18 : 0.045)
  const active = blend(isDark ? inset : ink, raised, isDark ? 0.32 : 0.08)
  const border = (alpha: number) => blend(ink, canvas, alpha)

  return {
    "background-base": shell,
    "background-weak": inset,
    "background-strong": raised,
    "background-stronger": canvas,
    "surface-base": blend(ink, canvas, isDark ? 0.03 : 0.04),
    "surface-base-hover": blend(ink, canvas, isDark ? 0.055 : 0.075),
    "surface-base-active": blend(ink, canvas, isDark ? 0.08 : 0.11),
    "surface-inset-base": inset,
    "surface-inset-base-hover": blend(ink, inset, 0.045),
    "surface-inset-strong": inset,
    "surface-inset-strong-hover": shell,
    "surface-raised-base": raised,
    "surface-raised-base-hover": hover,
    "surface-raised-base-active": active,
    "surface-raised-strong": raised,
    "surface-raised-strong-hover": hover,
    "surface-raised-stronger": raised,
    "surface-raised-stronger-hover": hover,
    "surface-raised-stronger-non-alpha": raised,
    "surface-panel": blend(ink, canvas, isDark ? 0.045 : 0.03),
    "surface-weak": shell,
    "surface-weaker": inset,
    "surface-strong": raised,
    "input-base": raised,
    "input-hover": hover,
    "input-disabled": inset,
    "button-secondary-base": raised,
    "button-secondary-hover": hover,
    "button-secondary-active": active,
    "button-ghost-hover": blend(ink, canvas, 0.065),
    "button-ghost-hover2": blend(ink, canvas, 0.1),
    "border-base": border(isDark ? 0.21 : 0.19),
    "border-hover": border(isDark ? 0.29 : 0.27),
    "border-active": border(isDark ? 0.36 : 0.34),
    "border-weak-base": border(isDark ? 0.15 : 0.12),
    "border-weaker-base": border(isDark ? 0.09 : 0.07),
    "border-strong-base": border(isDark ? 0.29 : 0.25),
    "text-strong": text(isDark ? 0.055 : -0.055),
    "text-base": text(0),
    "text-weak": text(isDark ? -0.07 : 0.07),
    "text-weaker": text(isDark ? -0.11 : 0.11),
    "markdown-text": text(0),
    "markdown-code-block": text(0),
  }
}

export function restrainedColor(color: HexColor, isDark: boolean, maximum = isDark ? 0.145 : 0.17): HexColor {
  const tone = hexToOklch(color)
  return tone.c <= maximum ? color : oklchToHex({ ...tone, c: maximum })
}

export function surfaceChromaLimit(key: string, isDark: boolean): number | undefined {
  if (/^surface-interactive-|^input-(active|selected|focus)$/.test(key)) return isDark ? 0.035 : 0.025
  if (/^surface-(success|warning|critical|info)-(base|weak)$/.test(key)) return isDark ? 0.035 : 0.025
  if (/^surface-diff-(add|delete|hidden)-/.test(key)) return isDark ? 0.04 : 0.03
  if (/^avatar-background-/.test(key)) return isDark ? 0.045 : 0.035
  if (/^surface-brand-|^surface-(success|warning|critical|info)-strong$/.test(key)) return isDark ? 0.075 : 0.085
}

export function restrainThemeChroma(tokens: ResolvedTheme, isDark: boolean) {
  for (const [key, value] of Object.entries(tokens)) {
    if (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) {
      // Large-area fills need a much lower chroma ceiling than small syntax or status marks.
      tokens[key] = restrainedColor(value as HexColor, isDark, surfaceChromaLimit(key, isDark))
    }
  }
}

// Contrast correction must not collapse body, heading and secondary text into one tone.
export function preserveTextHierarchy(tokens: ResolvedTheme, isDark: boolean, overrides: ResolvedTheme) {
  if (
    ["text-weaker", "text-weak", "text-base", "text-strong"].some(
      (key) => !/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(tokens[key]),
    )
  )
    return
  const direction = isDark ? 1 : -1
  let previous = hexToOklch(tokens["text-weaker"] as HexColor).l
  for (const [key, gap] of [
    ["text-weak", 0.025],
    ["text-base", 0.045],
    ["text-strong", 0.035],
  ] as const) {
    const tone = hexToOklch(tokens[key] as HexColor)
    if (!(key in overrides) && (tone.l - previous) * direction < gap) {
      tokens[key] = oklchToHex({ ...tone, l: previous + direction * gap })
    }
    previous = hexToOklch(tokens[key] as HexColor).l
  }
  if (!("text-stronger" in overrides)) tokens["text-stronger"] = tokens["text-strong"]
  if (!("markdown-text" in overrides)) tokens["markdown-text"] = tokens["text-base"]
  if (!("markdown-code-block" in overrides)) tokens["markdown-code-block"] = tokens["text-base"]
}
