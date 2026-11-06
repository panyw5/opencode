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

// Lexical coloring only: never interprets code or creates HTML from its text.
export function tokenizeWolfram(source: string): WolframToken[] {
  // Check before regexes or comment/string scans: a single token can itself be huge.
  if (!canHighlightWolfram(source)) return [{ kind: "plain", text: source }]
  const tokens: WolframToken[] = []
  const emit = (kind: WolframToken["kind"], start: number, end: number) => {
    const text = source.slice(start, end)
    const previous = tokens.at(-1)
    if (kind === "plain" && previous?.kind === kind) previous.text += text
    else tokens.push({ kind, text })
  }
  for (let index = 0; index < source.length; ) {
    if (tokens.length >= MAX_HIGHLIGHT_TOKENS) {
      emit("plain", index, source.length)
      break
    }
    const start = index
    const char = source[index]
    if (source.startsWith("(*", index)) {
      let depth = 1
      index += 2
      while (index < source.length && depth) {
        if (source.startsWith("(*", index)) {
          depth++
          index += 2
        } else if (source.startsWith("*)", index)) {
          depth--
          index += 2
        } else index++
      }
      emit("comment", start, index)
      continue
    }
    if (char === '"') {
      index++
      while (index < source.length) {
        if (source[index] === "\\") {
          index = Math.min(source.length, index + 2)
          continue
        }
        if (source[index++] === '"') break
      }
      emit("string", start, index)
      continue
    }
    named.lastIndex = index
    const escape = named.exec(source)?.[0]
    if (escape) {
      index += escape.length
      const name = escape.slice(2, -1)
      emit(namedOperators.has(name) ? "operator" : constants.has(name) ? "constant" : "symbol", start, index)
      continue
    }
    number.lastIndex = index
    const numeric = number.exec(source)?.[0]
    if (numeric) {
      index += numeric.length
      emit("number", start, index)
      continue
    }
    symbol.lastIndex = index
    const identifier = symbol.exec(source)?.[0]
    if (identifier) {
      index += identifier.length
      const name = identifier.split("`").at(-1) ?? identifier
      let next = index
      while (/\s/.test(source[next] ?? "") && next < source.length) next++
      emit(
        constants.has(name) || name.startsWith("$")
          ? "constant"
          : source[next] === "[" || /^[A-Z]/.test(name)
            ? "function"
            : "symbol",
        start,
        index,
      )
      continue
    }
    if (char === "_" || char === "#" || char === "%") {
      index++
      while (source[index] === char) index++
      if (char === "#" || char === "%") while (/[0-9]/.test(source[index] ?? "")) index++
      emit("pattern", start, index)
      continue
    }
    index++
    emit(
      "[]{}(),;".includes(char) ? "punctuation" : "+-*/^=<>!:?@&|~.\\".includes(char) ? "operator" : "plain",
      start,
      index,
    )
  }
  return tokens
}
