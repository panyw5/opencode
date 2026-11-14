export type WolframToken = {
  kind:
    | "plain"
    | "comment"
    | "string"
    | "number"
    | "function"
    | "constant"
    | "symbol"
    | "pattern"
    | "operator"
    | "punctuation"
  text: string
}

export const MAX_HIGHLIGHT_TOKENS = 4000
export const MAX_HIGHLIGHT_CHARACTERS = 64 * 1024

export function canHighlightWolfram(source: string) {
  return source.length <= MAX_HIGHLIGHT_CHARACTERS
}

const constants = new Set([
  "True",
  "False",
  "Null",
  "None",
  "All",
  "Automatic",
  "Infinity",
  "ComplexInfinity",
  "Indeterminate",
  "Pi",
  "E",
  "I",
  "Degree",
])
const symbol = /[\p{L}$][\p{L}\p{N}$`]*|`[\p{L}\p{N}$`]+/uy
const number =
  /(?:[0-9]+\^\^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]*)?|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))(?:`{1,2}(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)?)?(?:\*\^[+-]?[0-9]+)?/y
const named = /\\\[[a-zA-Z][a-zA-Z0-9]*\]/y
const namedOperators = new Set([
  "Rule",
  "RuleDelayed",
  "Equal",
  "Unequal",
  "LessEqual",
  "GreaterEqual",
  "And",
  "Or",
  "Not",
  "Times",
  "InvisibleTimes",
  "Element",
  "NotElement",
  "Function",
  "Condition",
])

export type WolframState = { commentDepth: number; string: boolean; escaped: boolean }
export type WolframCursor = WolframState & { offset: number }

export function wolframCursor(state?: WolframState): WolframCursor {
  return {
    offset: 0,
    commentDepth: state?.commentDepth ?? 0,
    string: state?.string ?? false,
    escaped: state?.escaped ?? false,
  }
}

type Emit = (kind: WolframToken["kind"], start: number, end: number) => void

/** Resumable lexical scan. The soft limit can split comments/strings, never identifiers or delimiters. */
export function scanWolfram(source: string, cursor: WolframCursor, emit?: Emit, until = source.length) {
  const limit = Math.min(source.length, until)
  while (cursor.offset < limit) {
    const start = cursor.offset
    if (cursor.commentDepth || source.startsWith("(*", start)) {
      if (!cursor.commentDepth) {
        cursor.commentDepth = 1
        cursor.offset += 2
      }
      while (cursor.offset < limit && cursor.commentDepth) {
        if (source.startsWith("(*", cursor.offset)) {
          cursor.commentDepth++
          cursor.offset += 2
        } else if (source.startsWith("*)", cursor.offset)) {
          cursor.commentDepth--
          cursor.offset += 2
        } else cursor.offset++
      }
      emit?.("comment", start, cursor.offset)
      continue
    }
    if (cursor.string || source[start] === '"') {
      if (!cursor.string) {
        cursor.string = true
        cursor.offset++
      }
      while (cursor.offset < limit && cursor.string) {
        const char = source[cursor.offset++]
        if (cursor.escaped) cursor.escaped = false
        else if (char === "\\") cursor.escaped = true
        else if (char === '"') cursor.string = false
      }
      emit?.("string", start, cursor.offset)
      continue
    }
    named.lastIndex = start
    const escape = named.exec(source)?.[0]
    if (escape) {
      cursor.offset += escape.length
      const name = escape.slice(2, -1)
      emit?.(namedOperators.has(name) ? "operator" : constants.has(name) ? "constant" : "symbol", start, cursor.offset)
      continue
    }
    number.lastIndex = start
    const numeric = number.exec(source)?.[0]
    if (numeric) {
      cursor.offset += numeric.length
      emit?.("number", start, cursor.offset)
      continue
    }
    symbol.lastIndex = start
    const identifier = symbol.exec(source)?.[0]
    if (identifier) {
      cursor.offset += identifier.length
      const name = identifier.split("`").at(-1) ?? identifier
      let next = cursor.offset
      while (next < source.length && /\s/.test(source[next])) next++
      emit?.(
        constants.has(name) || name.startsWith("$")
          ? "constant"
          : source[next] === "[" || /^[A-Z]/.test(name)
            ? "function"
            : "symbol",
        start,
        cursor.offset,
      )
      continue
    }
    const char = source[cursor.offset++]
    if (char === "_" || char === "#" || char === "%") {
      while (source[cursor.offset] === char) cursor.offset++
      if (char === "#" || char === "%") while (/[0-9]/.test(source[cursor.offset] ?? "")) cursor.offset++
      emit?.("pattern", start, cursor.offset)
      continue
    }
    emit?.(
      "[]{}(),;".includes(char) ? "punctuation" : "+-*/^=<>!:?@&|~.\\".includes(char) ? "operator" : "plain",
      start,
      cursor.offset,
    )
  }
  return cursor
}

/** Lexical coloring only: never interprets code or creates HTML from its text. */
export function tokenizeWolfram(source: string): WolframToken[] {
  if (!canHighlightWolfram(source)) return [{ kind: "plain", text: source }]
  const tokens: WolframToken[] = []
  const cursor = wolframCursor()
  let fallback = -1
  scanWolfram(source, cursor, (kind, start, end) => {
    if (fallback >= 0) return
    if (tokens.length >= MAX_HIGHLIGHT_TOKENS) {
      fallback = start
      return
    }
    const text = source.slice(start, end)
    const previous = tokens.at(-1)
    if (kind === "plain" && previous?.kind === kind) previous.text += text
    else tokens.push({ kind, text })
  })
  if (fallback >= 0) tokens.push({ kind: "plain", text: source.slice(fallback) })
  return tokens
}

export { formatWolfram, type FormatOptions } from "./format"
