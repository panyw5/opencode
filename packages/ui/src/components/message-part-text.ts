/** Zero-width / BOM characters that survive String#trim() but render as blank. */
const INVISIBLE = /[\u200B\u200C\u200D\uFEFF]/g

/** True when text has at least one visible (non-whitespace, non-zero-width) character. */
export function hasVisibleText(text: string | undefined | null): boolean {
  if (!text) return false
  return text.replace(INVISIBLE, "").trim().length > 0
}

export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  const raw = accum?.[part.id] ?? part.text ?? ""
  return raw.replace(INVISIBLE, "").trim()
}
