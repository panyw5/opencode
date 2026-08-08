const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "declare",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "of",
  "return",
  "satisfies",
  "static",
  "super",
  "switch",
  "throw",
  "try",
  "type",
  "typeof",
  "using",
  "var",
  "void",
  "while",
  "with",
  "yield",
])

const PRIMITIVES = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"])

const PUNCT = new Set(["(", ")", "[", "]", "{", "}", ".", ",", ";", ":", "?"])

const safe = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

const tint = (value: string, color: string) => `<span style="color:${color}">${safe(value)}</span>`

function tokenColor(value: string) {
  if (value.startsWith("//") || value.startsWith("/*")) return "var(--syntax-comment)"
  if (['"', "'", "`"].includes(value[0] ?? "")) return "var(--syntax-string)"
  if (PRIMITIVES.has(value)) return "var(--syntax-primitive)"
  if (/^\d/.test(value)) return "var(--syntax-constant)"
  if (PUNCT.has(value)) return "var(--syntax-punctuation)"
  if (KEYWORDS.has(value)) return "var(--syntax-keyword)"
  return "var(--text-base)"
}

/** Lightweight JS/JSON syntax highlighter for overlay editors. */
export function paintCode(raw: string) {
  const rule =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b|[()[\]{}.,;:?]/g

  let at = 0
  let out = ""

  for (const hit of raw.matchAll(rule)) {
    const idx = hit.index ?? 0
    if (idx > at) out += safe(raw.slice(at, idx))
    const value = hit[0]
    out += tint(value, tokenColor(value))
    at = idx + value.length
  }

  if (at < raw.length) out += safe(raw.slice(at))
  return out || "&nbsp;"
}
