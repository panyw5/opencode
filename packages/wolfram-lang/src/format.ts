import { scanWolfram, wolframCursor, type WolframToken } from "./wolfram"

export type FormatOptions = {
  /** Line width above which bracketed groups with separators break. */
  width?: number
  /** Indentation unit applied per nested broken group. */
  indent?: string
}

const DEFAULT_WIDTH = 80
const DEFAULT_INDENT = "  "

/**
 * Multi-character operators and brackets assembled from adjacent single-char
 * scan tokens. Three-character entries are matched before two-character ones.
 */
const COMPOUND3 = new Set(["===", "=!=", ">>>", "...", "//@", "//.", "^:="])
const ASSOC_OPEN = "<" + "|"
const ASSOC_CLOSE = "|" + ">"
const COMPOUND2 = new Set([
  ASSOC_OPEN,
  ASSOC_CLOSE,
  "::",
  ";;",
  "..",
  "??",
  ":=",
  "->",
  ":>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "^=",
  "<<",
  ">>",
  "<>",
  "~~",
  "**",
  "^^",
  "/;",
  "/:",
  "/.",
  "//",
  "/@",
  "@@",
  "=.",
])

const OPENERS = new Set(["(", "[", "{", ASSOC_OPEN])
const CLOSERS = new Set([")", "]", "}", ASSOC_CLOSE])
const MATCH: Record<string, string> = { "(": ")", "[": "]", "{": "}", [ASSOC_OPEN]: ASSOC_CLOSE }
const KIND_OPEN: Record<string, string> = { "(": "(", "[": "[", "{": "{", [ASSOC_OPEN]: "{" }

/** Tokens that never take a space before them. */
const TIGHT_BEFORE = new Set(["::", ";;", "?", "??", "..", "...", ":", ".", "'", "++", "--"])
/** Tokens that never take a space after them (prefix/context-tight). */
const TIGHT_AFTER = new Set(["::", ";;", "?", "??", ":", "."])
/** Postfix operators: tight against their operand, operand-like afterwards. */
const POSTFIX = new Set(["&", "..", "...", "'"])
/** Operators with a space on both sides. Everything else single-char is too. */
const PREFIX_TIGHT_AFTER = new Set(["<<"])

const OPERAND_KINDS = new Set(["symbol", "function", "constant", "number", "string", "pattern", "plain"])

type Token = {
  kind: WolframToken["kind"]
  text: string
  /** Newlines in the whitespace gap before this token (0 = adjacent or same line). */
  nl: number
  /** True when the source had no whitespace between this token and the previous one. */
  adjacent: boolean
  unary: boolean
  /** Index of the matching close for openers, or of the opener for closers. */
  pair: number
  /** Index of the innermost enclosing opener, -1 at top level. */
  inner: number
}

function isOperandLike(token: Token): boolean {
  if (OPERAND_KINDS.has(token.kind) || CLOSERS.has(token.text)) return true
  if (POSTFIX.has(token.text) || (token.text === "++" || token.text === "--" || token.text === "!") && !token.unary) return true
  return false
}

/**
 * One-click Wolfram Language beautifier. Rewrites whitespace only:
 * keeps every original line break (a newline can terminate a complete
 * expression, so removing one would change semantics), collapses runs of
 * blank lines to one, and additionally breaks after `;`, inside long or
 * multiline bracket groups, and around binary operators.
 */
export function formatWolfram(source: string, options: FormatOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH
  const unit = options.indent ?? DEFAULT_INDENT

  let code = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  let shebang = ""
  if (code.startsWith("#!")) {
    const end = code.indexOf("\n")
    if (end === -1) return code
    shebang = code.slice(0, end + 1)
    code = code.slice(end + 1)
  }

  // --- pass 1: lex into raw segments; whitespace runs become gap metadata --
  const segments: { kind: WolframToken["kind"]; text: string }[] = []
  const cursor = wolframCursor()
  scanWolfram(code, cursor, (kind, start, end) => segments.push({ kind, text: code.slice(start, end) }))
  const raw: { kind: WolframToken["kind"]; text: string; adjacent: boolean; nl: number }[] = []
  let gapNl = 0
  let gapAny = false
  for (const segment of segments) {
    if (/^\s+$/.test(segment.text)) {
      gapNl += (segment.text.match(/\n/g) ?? []).length
      gapAny = true
      continue
    }
    raw.push({ kind: segment.kind, text: segment.text, adjacent: !gapAny, nl: gapNl })
    gapNl = 0
    gapAny = false
  }

  // --- pass 2: merge adjacent operator/punctuation runs into compounds ----
  const tokens: Token[] = []
  const mergeable = (kind: WolframToken["kind"]) => kind === "operator" || kind === "punctuation"
  for (let index = 0; index < raw.length; ) {
    const item = raw[index]
    // Never merge across `,` — it belongs to no compound.
    if (item.text === "," || !mergeable(item.kind)) {
      tokens.push({ ...item, unary: false, pair: -1, inner: -1 })
      index++
      continue
    }
    // Collect the adjacent run (no whitespace between items).
    const run: typeof raw = [item]
    let cursorIndex = index + 1
    while (
      cursorIndex < raw.length &&
      raw[cursorIndex].adjacent &&
      raw[cursorIndex].text !== "," &&
      mergeable(raw[cursorIndex].kind)
    ) {
      run.push(raw[cursorIndex])
      cursorIndex++
    }
    // Longest-match split of the run into compound operators.
    let at = 0
    while (at < run.length) {
      const three = run.slice(at, at + 3)
      const two = run.slice(at, at + 2)
      let text = run[at].text
      let size = 1
      if (three.length === 3 && COMPOUND3.has(three.map((part) => part.text).join(""))) {
        text = three.map((part) => part.text).join("")
        size = 3
      } else if (two.length === 2 && COMPOUND2.has(two.map((part) => part.text).join(""))) {
        text = two.map((part) => part.text).join("")
        size = 2
      }
      tokens.push({
        kind: item.kind,
        text,
        nl: run[at].nl,
        adjacent: run[at].adjacent,
        unary: false,
        pair: -1,
        inner: -1,
      })
      at += size
    }
    index = cursorIndex
  }

  // --- pass 3: match brackets, find innermost group per token -------------
  const stack: number[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    token.inner = stack.length ? stack[stack.length - 1] : -1
    if (OPENERS.has(token.text)) {
      token.inner = stack.length ? stack[stack.length - 1] : -1
      stack.push(index)
    } else if (CLOSERS.has(token.text)) {
      for (let scan = stack.length - 1; scan >= 0; scan--) {
        if (MATCH[tokens[stack[scan]].text] === token.text) {
          token.pair = stack[scan]
          tokens[stack[scan]].pair = index
          stack.length = scan
          break
        }
      }
      token.inner = stack.length ? stack[stack.length - 1] : -1
    }
  }

  // --- pass 4: decide which groups break to multiple lines ----------------
  const broken = new Set<number>()
  const semi = new Set<number>()
  const comma = new Set<number>()
  const nestedInline = new Map<number, number>()
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.text === ";") semi.add(token.inner)
    else if (token.text === ",") comma.add(token.inner)
    // A group is broken when the source already breaks inside it.
    if (token.nl > 0 && token.inner >= 0) broken.add(token.inner)
    if (token.inner >= 0) {
      nestedInline.set(token.inner, (nestedInline.get(token.inner) ?? 0) + token.text.length + 1)
    }
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (!OPENERS.has(token.text) || token.pair < 0) continue
    const kind = KIND_OPEN[token.text]
    // The call head counts toward the group's inline width (f[a, b] breaks
    // sooner than a bare {a, b} of the same content length).
    const head = index > 0 && OPERAND_KINDS.has(tokens[index - 1].kind) ? tokens[index - 1].text.length : 0
    const length = (nestedInline.get(index) ?? 0) + token.text.length + head
    if (broken.has(index)) continue
    // `{`/`(` groups containing statements always break; long groups with
    // separators break past the width limit, like a list or argument wrap.
    if ((kind === "{" || kind === "(") && semi.has(index)) broken.add(index)
    else if (comma.has(index) && length > width) broken.add(index)
  }
  // A group containing a broken child group breaks as well — innermost first.
  const openers: number[] = []
  for (let index = 0; index < tokens.length; index++) if (OPENERS.has(tokens[index].text)) openers.push(index)
  const nesting = (index: number) => {
    let depth = 0
    for (let at = tokens[index].inner; at >= 0; at = tokens[at].inner) depth++
    return depth
  }
  openers.sort((a, b) => nesting(b) - nesting(a))
  for (const index of openers) if (broken.has(index) && tokens[index].inner >= 0) broken.add(tokens[index].inner)

  // brokenDepth before each token; closing brackets already sit one level out.
  // A broken opener immediately followed by another opener is "hugged" — the
  // inner group owns the indentation, the outer one stays glued to it.
  const hugged = new Set<number>()
  for (let index = 0; index + 1 < tokens.length; index++) {
    if (broken.has(index) && OPENERS.has(tokens[index + 1].text)) hugged.add(index)
  }
  const depthOf: number[] = []
  {
    const live: number[] = []
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (CLOSERS.has(token.text) && token.pair >= 0 && broken.has(token.pair)) live.pop()
      depthOf[index] = live.filter((entry) => !hugged.has(entry)).length
      if (OPENERS.has(token.text) && broken.has(index)) live.push(index)
    }
  }

  // --- pass 5: spacing rules ----------------------------------------------
  // `a_b` is a named pattern but `a_ b` is a product — the only pair where
  // the original adjacency must be preserved.
  const space = (prev: Token | undefined, next: Token): string => {
    if (!prev) return ""
    if (OPENERS.has(prev.text)) return ""
    if (CLOSERS.has(next.text) || next.text === "," || next.text === ";") return ""
    if (TIGHT_BEFORE.has(next.text) || TIGHT_AFTER.has(prev.text) || PREFIX_TIGHT_AFTER.has(prev.text)) return ""
    if (["++", "--", "-", "+", "!"].includes(prev.text) && prev.unary) return ""
    // `!`/`&` glue to a preceding operand (factorial, Function); elsewhere
    // they are prefix-position and take a normal gap.
    if (next.text === "!" || next.text === "&") return isOperandLike(prev) ? "" : " "
    // `a_b` is a named pattern but `a_ b` is a product — the only pair where
    // the original adjacency must be preserved.
    if (
      prev.kind === "pattern" &&
      /^_+$/.test(prev.text) &&
      (next.kind === "symbol" || next.kind === "function")
    )
      return next.adjacent ? "" : " "
    if ((prev.kind === "symbol" || prev.kind === "function") && next.kind === "pattern" && next.text.startsWith("_"))
      return next.adjacent ? "" : " "
    if (prev.text === "," || prev.text === ";") return " "
    if (next.text === "[") return isOperandLike(prev) ? "" : " "
    return " "
  }

  // --- pass 6: emit --------------------------------------------------------
  let out = shebang
  const newline = (depth: number, blank: boolean) => {
    out = out.replace(/[ \t]+$/, "")
    out += blank ? "\n\n" : "\n"
    out += unit.repeat(depth)
  }
  for (let index = 0; index < tokens.length; index++) {
    const cur = tokens[index]
    const prev = index ? tokens[index - 1] : undefined
    if (prev) {
      const closesBroken = CLOSERS.has(cur.text) && cur.pair >= 0 && broken.has(cur.pair)
      const opensBroken = OPENERS.has(prev.text) && broken.has(index - 1) && !OPENERS.has(cur.text)
      const semiBreak = prev.text === ";" && (prev.inner === -1 || broken.has(prev.inner))
      const commaBreak = prev.text === "," && prev.inner >= 0 && broken.has(prev.inner)
      if (closesBroken || opensBroken || semiBreak || commaBreak || cur.nl > 0) {
        newline(depthOf[index], cur.nl >= 2)
      } else {
        const gap = space(prev, cur)
        if (gap) out += gap
      }
    }
    // Mark prefix-position operators so the next gap stays tight.
    if (["!", "+", "-", "++", "--"].includes(cur.text)) {
      cur.unary = !prev || !isOperandLike(prev)
    }
    out += cur.text
  }
  const trimmed = out.replace(/[ \t\n]+$/, "")
  return trimmed ? trimmed + "\n" : shebang || ""
}
