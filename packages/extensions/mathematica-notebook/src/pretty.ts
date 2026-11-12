import { tokenizeWolfram, type WolframToken } from "./highlight"
import { namedCharacters } from "./named-chars"

// Lightweight display-only structuring of Wolfram source: fractions, powers,
// radicals, subscripts and common operator glyphs. Mirrors how Mathematica's
// input cells typeset the written source; never used for editing or saving.
export type Pretty =
  | { kind: "tok"; cls: string; text: string }
  | { kind: "frac"; num: Pretty[]; den: Pretty[] }
  | { kind: "sup"; base: Pretty[]; exp: Pretty[] }
  | { kind: "sub"; base: Pretty[]; sub: Pretty[] }
  | { kind: "sqrt"; arg: Pretty[] }
  | { kind: "group"; open: string; inner: Pretty[]; close: string; tall: boolean }

type Tok = { kind: string; text: string }

// Adjacent single-character operator/punctuation tokens combined before parsing.
const MERGE = new Set([
  "===",
  "=!=",
  "<->",
  ">>>",
  "//=",
  "//.",
  "//@",
  "...",
  "==",
  "!=",
  "<=",
  ">=",
  "->",
  ":>",
  ":=",
  "/;",
  "/:",
  "//",
  "/@",
  "@@",
  "@*",
  "&&",
  "||",
  "..",
  "<<",
  ">>",
  "=.",
  "+=",
  "-=",
  "*=",
  "/=",
  "^=",
  ";;",
  "**",
  "--",
  "++",
  "~~",
  "??",
  "::",
  "[[",
  "]]",
  "\u003c|",
  "|>",
  "!!",
  "^^",
])

const GLYPHS: Record<string, string> = {
  "<=": "≤",
  ">=": "≥",
  "!=": "≠",
  "===": "≡",
  "=!=": "≢",
  "->": "→",
  ":>": "⧴",
  "<->": "↔",
  "*": "×",
  "&&": "∧",
  "||": "∨",
  "::": "∶∶",
}

const CLOSERS: Record<string, string> = {
  "(": ")",
  "{": "}",
  "[": "]",
  "[[": "]]",
  "\u003c|": "|>",
}

const ATOMS = new Set(["number", "string", "constant", "symbol", "function", "pattern"])
const OPENERS = new Set(["(", "{", "[", "[[", "\u003c|"])
const isSpace = (t: Tok) => t.kind === "plain" && /^\s+$/.test(t.text)
const isFiller = (t: Tok) => isSpace(t) || t.kind === "comment"
const atomStart = (t: Tok) => ATOMS.has(t.kind) || OPENERS.has(t.text)
const UNARY = new Set(["-", "+", "!", "++", "--"])

// Function arguments keep the author's spacing; trim it when an argument is
// lifted into a compact position (radicand, subscript).
const trim = (items: Pretty[]) => {
  const blank = (p: Pretty) => p.kind === "tok" && /^\s+$/.test(p.text)
  let a = 0
  let b = items.length
  while (a < b && blank(items[a])) a++
  while (b > a && blank(items[b - 1])) b--
  return items.slice(a, b)
}

// A fraction bar groups its operands on its own, so a sole (...) around
// the whole numerator or denominator is dropped from the display, like
// Mathematica's typeset input.
const unparen = (items: Pretty[]) => {
  const t = trim(items)
  return t.length === 1 && t[0].kind === "group" && t[0].open === "(" && t[0].close === ")"
    ? t[0].inner
    : t
}

type PGroup = {
  kind: "group"
  open: string
  inner: Pretty[]
  close: string
  tall: boolean
  args: Pretty[][]
}

// Whether a group's contents stand taller than one line of source: any
// fraction, or a taller construct (radical, script) carrying one. Drives the
// drawn-stroke delimiters in the view.
const tall = (n: Pretty): boolean => {
  switch (n.kind) {
    case "frac":
      return true
    case "sqrt":
      return n.arg.some(tall)
    case "sup":
      return n.base.some(tall) || n.exp.some(tall)
    case "sub":
      return n.base.some(tall) || n.sub.some(tall)
    case "group":
      return n.tall
    default:
      return false
  }
}

class Parser {
  i = 0
  constructor(readonly toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i]
  }
  next() {
    return this.toks[this.i++]
  }
  filler(from = this.i) {
    while (from < this.toks.length && isFiller(this.toks[from])) from++
    return from
  }
  tok(t: Tok, cls?: string): Pretty {
    return { kind: "tok", cls: cls ?? t.kind, text: namedCharacters(GLYPHS[t.text] ?? t.text) }
  }
  // (...) {...} [...] [[...]] 
  // Bracketed group with comma-separated arguments.
  group(): PGroup {
    const open = this.next()!
    const closer = CLOSERS[open.text]
    const inner: Pretty[] = []
    const args: Pretty[][] = []
    // mergeOps folds adjacent ] into ]], which still must close a single-[.
    // Stopping on it here lets takeClose split off the leftover ] for an
    // enclosing bracket (GetAlgebra[a[b]] keeps both ends).
    const stop = new Set([",", closer, "]]"])
    const atClose = (t: Tok) => t.text === closer || (closer === "]" && t.text === "]]")
    let close = ""
    const takeClose = () => {
      const t = this.next()!
      if (t.text === "]]") {
        close = "]"
        this.toks.splice(this.i, 0, { kind: "punctuation", text: "]" })
      } else close = t.text
    }
    while (this.peek()) {
      const t = this.peek()!
      if (t.text === ",") break
      if (atClose(t)) {
        takeClose()
        break
      }
      const arg = this.seq(stop)
      args.push(arg)
      inner.push(...arg)
      const n = this.peek()
      if (!n) break
      if (n.text === ",") {
        inner.push(this.tok(n))
        this.next()
        continue
      }
      if (atClose(n)) takeClose()
      break
    }
    return { kind: "group", open: open.text, inner, close, tall: inner.some(tall), args }
  }

  // A single primary expression: literal, name, blank, slot or bracketed group.
  atomish(): Pretty[] {
    const t = this.peek()
    if (!t) return []
    if (OPENERS.has(t.text)) return [this.group()]
    if (ATOMS.has(t.kind)) {
      this.next()
      const items = [this.tok(t)]
      // _h / __h : pattern head attaches only when adjacent.
      if (t.text.startsWith("_")) {
        const d = this.peek()
        if (d && ATOMS.has(d.kind)) items.push(...this.atomish())
      }
      return items
    }
    return []
  }

  // atom + postfix (calls, patterns, ', !, &) + optional ^ exponent.
  factor(): Pretty[] {
    const t = this.peek()
    if (!t) return []
    if (UNARY.has(t.text)) {
      this.next()
      return [this.tok(t), ...this.factor()]
    }
    let atom = this.atomish()
    if (!atom.length) return []
    while (true) {
      const t2 = this.peek()
      if (!t2) break
      if (t2.text === "[" || t2.text === "[[") {
        const grp = this.group()
        const head = atom.length === 1 && atom[0].kind === "tok" ? atom[0].text : undefined
        if (t2.text === "[" && head === "Sqrt" && grp.args.length === 1) {
          atom = [{ kind: "sqrt", arg: trim(grp.args[0]) }]
        } else if (t2.text === "[" && head === "Subscript" && grp.args.length === 2) {
          atom = [{ kind: "sub", base: trim(grp.args[0]), sub: trim(grp.args[1]) }]
        } else {
          atom = [...atom, grp]
        }
        continue
      }
      // x_ x__ x_h pattern tail.
      if (t2.kind === "pattern" && t2.text.startsWith("_")) {
        this.next()
        const seg = [this.tok(t2)]
        const d = this.peek()
        if (d && ATOMS.has(d.kind)) seg.push(...this.atomish())
        atom = [...atom, ...seg]
        continue
      }
      // Derivative ' '' ''' ; factorial ! !! ; function postfix &.
      if (t2.kind === "plain" && /^'+$/.test(t2.text)) {
        atom = [...atom, this.tok(t2)]
        this.next()
        continue
      }
      if (t2.text === "!" || t2.text === "!!" || t2.text === "&") {
        atom = [...atom, this.tok(t2)]
        this.next()
        continue
      }
      break
    }
    if (this.peek()?.text === "^") {
      this.next()
      return [{ kind: "sup", base: atom, exp: this.factor() }]
    }
    return atom
  }

  // Multiplicative level: / produces a fraction of its immediate operands.
  times(): Pretty[] {
    let acc = this.factor()
    while (true) {
      const t = this.peek()
      if (!t) break
      if (t.text === "*" || t.text === "." || t.text === "**") {
        this.next()
        const f = this.factor()
        acc = f.length ? [...acc, this.tok(t, "operator"), ...f] : [...acc, this.tok(t)]
        continue
      }
      if (t.text === "/") {
        this.next()
        const den = this.factor()
        if (!den.length) {
          acc = [...acc, this.tok(t)]
          continue
        }
        acc = [{ kind: "frac", num: unparen(acc), den: unparen(den) }]
        continue
      }
      if (isFiller(t)) {
        const next = this.filler()
        const d = this.toks[next]
        if (d && atomStart(d)) {
          const sep = this.toks.slice(this.i, next).map((f) => this.tok(f))
          this.i = next
          acc = [...acc, ...sep, ...this.factor()]
          continue
        }
      }
      break
    }
    return acc
  }

  additive(): Pretty[] {
    const items = this.times()
    while (true) {
      // Look past filler so a spaced `x - y` still binds as subtraction;
      // otherwise factor() would swallow the sign as unary into the next term.
      const after = this.filler()
      const t = this.toks[after]
      if (!t || (t.text !== "+" && t.text !== "-")) break
      items.push(...this.toks.slice(this.i, after).map((f) => this.tok(f)))
      this.i = after + 1
      items.push(this.tok(t), ...this.times())
    }
    return items
  }

  // Line/group body: additive expressions joined by any remaining tokens
  // (separators, rules, conditions, stray delimiters) kept verbatim.
  seq(stop: Set<string>): Pretty[] {
    const items: Pretty[] = []
    while (true) {
      const t = this.peek()
      if (!t || stop.has(t.text)) break
      items.push(...this.additive())
      const n = this.peek()
      if (!n || stop.has(n.text)) break
      items.push(this.tok(n))
      this.next()
    }
    return items
  }
}

function mergeOps(tokens: WolframToken[]): Tok[] {
  const out: Tok[] = []
  const single = (t: Tok) => t.text.length === 1 && (t.kind === "operator" || t.kind === "punctuation")
  for (const t of tokens) {
    out.push({ kind: t.kind, text: t.text })
    while (true) {
      const n = out.length
      if (n >= 3 && single(out[n - 3]) && single(out[n - 2]) && single(out[n - 1])) {
        const text = out[n - 3].text + out[n - 2].text + out[n - 1].text
        if (MERGE.has(text)) {
          out.splice(n - 3, 3, { kind: "operator", text })
          continue
        }
      }
      if (n >= 2 && single(out[n - 2]) && single(out[n - 1])) {
        const text = out[n - 2].text + out[n - 1].text
        if (MERGE.has(text)) {
          out.splice(n - 2, 2, { kind: "operator", text })
          continue
        }
      }
      break
    }
  }
  return out
}

const NO_STOP = new Set<string>()

// Parse source into per-line display nodes. Lines split at real newlines so the
// layout keeps the author's line structure like the screenshot editor.
export function prettyLines(source: string): Pretty[][] {
  const merged = mergeOps(tokenizeWolfram(source))
  const lines: Tok[][] = [[]]
  for (const t of merged) {
    const parts = t.text.split("\n")
    for (const [i, part] of parts.entries()) {
      if (i) lines.push([])
      if (part) lines.at(-1)!.push({ kind: t.kind, text: part })
    }
  }
  return lines.map((toks) => new Parser(toks).seq(NO_STOP))
}
