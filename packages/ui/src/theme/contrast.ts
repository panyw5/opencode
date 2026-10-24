import { blend, hexToOklch, hexToRgb, oklchToHex, rgbToHex } from "./color"
import type { HexColor, ResolvedTheme } from "./types"

export function contrastRatio(a: HexColor, b: HexColor) {
  const luminance = (color: HexColor) => {
    const rgb = hexToRgb(color)
    const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b)
  }
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// Resolve only colors whose rendered background is known; leave custom CSS expressions intact.
export function opaqueColor(
  value: string | undefined,
  tokens: ResolvedTheme,
  background: HexColor,
  seen = new Set<string>(),
): HexColor | undefined {
  if (!value) return
  const variable = /^var\(--([\w-]+)\)$/.exec(value)
  if (variable) {
    const key = variable[1]
    if (seen.has(key) || !tokens[key]) return
    seen.add(key)
    return opaqueColor(tokens[key], tokens, background, seen)
  }
  if (/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) return value as HexColor
  if (/^#(?:[\da-f]{4}|[\da-f]{8})$/i.test(value)) {
    const hex = value.length === 5 ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value
    return blend(hex.slice(0, 7) as HexColor, background, parseInt(hex.slice(7), 16) / 255)
  }
  const rgba = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/.exec(value)
  if (rgba) return blend(rgbToHex(+rgba[1] / 255, +rgba[2] / 255, +rgba[3] / 255), background, +(rgba[4] ?? 1))
}

export function readableColor(color: HexColor, surfaces: HexColor[], minimum: number): HexColor {
  const passes = (value: HexColor) => surfaces.every((surface) => contrastRatio(value, surface) >= minimum)
  if (passes(color)) return color
  const source = hexToOklch(color)
  const options = [0, 1].flatMap((l) => {
    const endpoint = oklchToHex({ ...source, l })
    if (!passes(endpoint)) return []
    let low = 0
    let high = 1
    for (let i = 0; i < 24; i++) {
      const amount = (low + high) / 2
      const candidate = oklchToHex({ ...source, l: source.l + (l - source.l) * amount })
      if (passes(candidate)) high = amount
      else low = amount
    }
    return [oklchToHex({ ...source, l: source.l + (l - source.l) * high })]
  })
  // A custom theme can mix both bright and dark surfaces. Do not flatten it if no solution exists.
  return options.sort((a, b) => Math.abs(hexToOklch(a).l - source.l) - Math.abs(hexToOklch(b).l - source.l))[0] ?? color
}

export const contentSurfaces = [
  "background-base",
  "background-weak",
  "background-strong",
  "background-stronger",
  "surface-base",
  "surface-base-hover",
  "surface-base-active",
  "surface-inset-base",
  "surface-inset-base-hover",
  "surface-raised-base",
  "surface-raised-base-hover",
  "surface-raised-base-active",
  "surface-raised-stronger-non-alpha",
  "surface-panel",
  "surface-weak",
  "surface-weaker",
  "input-base",
  "input-hover",
  "button-secondary-base",
  "button-secondary-hover",
  "button-secondary-active",
] as const

export function enforceThemeContrast(tokens: ResolvedTheme, isDark: boolean) {
  const background = opaqueColor(tokens["background-base"], tokens, isDark ? "#000000" : "#ffffff")
  if (!background) return
  const surfaces = contentSurfaces.flatMap((key) => {
    const color = opaqueColor(tokens[key], tokens, background)
    return color ? [color] : []
  })
  for (const key of [
    "text-base",
    "text-strong",
    "text-stronger",
    "text-weak",
    "text-weaker",
    "text-interactive-base",
    "text-success-base",
    "text-warning-base",
    "text-critical-base",
    "text-info-base",
    "markdown-text",
    "markdown-heading",
    "markdown-strong",
    "markdown-emph",
    "markdown-code",
    "markdown-link",
    "markdown-link-text",
    "markdown-code-block",
    "markdown-block-quote",
    "markdown-list-item",
    "markdown-list-enumeration",
    "markdown-image",
    "markdown-image-text",
    ...Object.keys(tokens).filter((key) => key.startsWith("syntax-")),
  ]) {
    const color = opaqueColor(tokens[key], tokens, background)
    if (color) tokens[key] = readableColor(color, surfaces, 4.6)
  }
  for (const key of [
    "icon-base",
    "icon-hover",
    "icon-active",
    "icon-selected",
    "icon-focus",
    "icon-weak-base",
    "icon-weak-hover",
    "icon-weak-active",
    "icon-weak-selected",
    "icon-weak-focus",
    "icon-strong-base",
    "icon-strong-hover",
    "icon-strong-active",
    "icon-strong-selected",
    "icon-strong-focus",
    "icon-brand-base",
    "icon-interactive-base",
    "icon-info-base",
    "icon-success-base",
    "icon-warning-base",
    "icon-critical-base",
  ]) {
    const color = opaqueColor(tokens[key], tokens, background)
    if (color) tokens[key] = readableColor(color, surfaces, 3.1)
  }
  for (const name of ["pink", "mint", "orange", "purple", "cyan", "lime"]) {
    const surface = opaqueColor(tokens[`avatar-background-${name}`], tokens, background)
    const color = opaqueColor(tokens[`avatar-text-${name}`], tokens, background)
    if (surface && color) tokens[`avatar-text-${name}`] = readableColor(color, [surface], 4.6)
  }
}
