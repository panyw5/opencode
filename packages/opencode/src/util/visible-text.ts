/** Zero-width / BOM characters that survive String#trim() but render as blank. */
const INVISIBLE = /[\u200B\u200C\u200D\uFEFF]/g
const INVISIBLE_EDGE = /^[\u200B\u200C\u200D\uFEFF]+|[\u200B\u200C\u200D\uFEFF]+$/g

/** True when text has at least one visible (non-whitespace, non-zero-width) character. */
export function hasVisibleText(text: string | undefined | null): boolean {
  if (!text) return false
  return text.replace(INVISIBLE, "").trim().length > 0
}

/** Strip leading/trailing zero-width characters that models sometimes prefix. */
export function stripInvisibleEdges(text: string): string {
  return text.replace(INVISIBLE_EDGE, "")
}

/**
 * Assistant text parts that should not be persisted after stream end.
 *
 * Keep empty string `""`: Anthropic adaptive thinking uses it as a structural
 * separator for signed reasoning (converted to `" "` on replay).
 * Drop zero-width-only / whitespace-only content (e.g. OpenAI `\u200b` stubs)
 * which otherwise render as blank markdown bubbles.
 */
export function shouldDropAssistantTextPart(text: string): boolean {
  if (text === "") return false
  return !hasVisibleText(text)
}
