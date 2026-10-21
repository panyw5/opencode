import { resolveThemeVariant } from "@opencode-ai/ui/theme/resolve"
import type { DesktopTheme } from "@opencode-ai/ui/theme/types"

const cache = new WeakMap<DesktopTheme, Partial<Record<"light" | "dark", Record<string, string>>>>()

export function themePreview(theme: DesktopTheme, mode: "light" | "dark") {
  const cached = cache.get(theme) ?? {}
  if (cached[mode]) return cached[mode]
  const tokens = resolveThemeVariant(theme[mode], mode === "dark")
  const color = (key: string, seen = new Set<string>()): string => {
    if (seen.has(key)) throw new Error(`Circular theme preview token: ${key}`)
    seen.add(key)
    const value = tokens[key]
    if (!value) throw new Error(`Missing theme preview token: ${key}`)
    const reference = /^var\(--([\w-]+)\)$/.exec(value)
    return reference ? color(reference[1], seen) : value
  }
  // Resolve references locally so a card never inherits colors from the active theme.
  const result = {
    "--preview-sidebar": color("background-base"),
    "--preview-session": color("background-stronger"),
    "--preview-topbar": color("background-base"),
    "--preview-popup": color("surface-raised-stronger-non-alpha"),
    "--preview-text": color("text-strong"),
    "--preview-muted": color("text-weak"),
    "--preview-border": color("border-weak-base"),
    "--preview-accent": color("surface-interactive-base"),
  }
  cached[mode] = result
  cache.set(theme, cached)
  return result
}
