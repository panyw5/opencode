import { Marked, type Token } from "marked"
import markedKatex from "marked-katex-extension"
import markedShiki from "marked-shiki"
import katex from "katex"
import { bundledLanguages, type BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { getSharedHighlighter, registerCustomTheme, ThemeRegistrationResolved } from "@pierre/diffs"

type MathOutput = "html" | "htmlAndMathml"

const latexPackageMacros = {
  "\\slashed": "\\mathrlap{\\not{\\phantom{#1}}}#1",
  "\\ket": "\\left|#1\\right\\rangle",
  "\\bra": "\\left\\langle#1\\right|",
  "\\braket": "\\left\\langle#1\\right\\rangle",
  "\\abs": "\\left|#1\\right|",
  "\\norm": "\\left\\lVert#1\\right\\rVert",
  "\\dv": "\\frac{d #1}{d #2}",
  "\\pdv": "\\frac{\\partial #1}{\\partial #2}",
} as const

function katexOptions(input: { output: MathOutput; displayMode?: boolean }): katex.KatexOptions {
  return {
    displayMode: input.displayMode,
    output: input.output,
    throwOnError: false,
    strict: "ignore",
    macros: { ...latexPackageMacros },
  }
}

// marked's GFM autolink stops at whitespace or "<" only, so a bare URL glued to
// Chinese prose swallows the rest of the sentence:
//   增加维护 https://axonhub-k34h.onrender.com，跟现在的2个render服务器… 
// would link the whole tail. Chinese has no word spaces, so a link has to end
// where CJK text starts. ASCII is left to marked: it already strips trailing
// punctuation and keeps balanced parentheses in URLs.
const autolinkProseChars =
  /[\u00a0\u2000-\u206f\u2e80-\u303f\ufe10-\ufe4f\uff00-\uffef]|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Bopomofo}/u

// Length of the URL at the start of `value`, or undefined when the URL already
// ends at a clean boundary (marked trims ASCII itself, so only CJK needs help).
// CJK prose always terminates a bare URL, so the cut point is the first CJK
// character; ASCII punctuation marked would have dropped from a shorter match is
// dropped here too.
function autolinkLength(value: string) {
  let end = -1
  for (let i = 0; i < value.length; i++) {
    if (autolinkProseChars.test(value[i])) {
      end = i
      break
    }
  }
  if (end === -1) return

  const cut = value.slice(0, end).replace(/[\s.,;:!?'"~*_]+$/, "")
  // "<a b>" is an HTML tag, not an autolink, so a cut spanning whitespace or an
  // angle bracket must not be wrapped.
  if (!cut || /[\s<>]/.test(cut)) return
  try {
    if (!new URL(cut).hostname) return
  } catch {
    return
  }
  return cut.length
}

export function normalizeAutolink(href: string, text: string) {
  const hrefTrimmed = href.trim()
  const textTrimmed = text.trim()
  if (!hrefTrimmed.startsWith("http://") && !hrefTrimmed.startsWith("https://")) return
  if (textTrimmed !== hrefTrimmed) return

  const length = autolinkLength(hrefTrimmed)
  if (!length) return

  return {
    href: hrefTrimmed.slice(0, length),
    text: textTrimmed.slice(0, length),
  }
}

registerCustomTheme("OpenCode", () => {
  return Promise.resolve({
    name: "OpenCode",
    colors: {
      "editor.background": "var(--color-background-stronger)",
      "editor.foreground": "var(--text-base)",
      "gitDecoration.addedResourceForeground": "var(--syntax-diff-add)",
      "gitDecoration.deletedResourceForeground": "var(--syntax-diff-delete)",
      // "gitDecoration.conflictingResourceForeground": "#ffca00",
      // "gitDecoration.modifiedResourceForeground": "#1a76d4",
      // "gitDecoration.untrackedResourceForeground": "#00cab1",
      // "gitDecoration.ignoredResourceForeground": "#84848A",
      // "terminal.titleForeground": "#adadb1",
      // "terminal.titleInactiveForeground": "#84848A",
      // "terminal.background": "#141415",
      // "terminal.foreground": "#adadb1",
      // "terminal.ansiBlack": "#141415",
      // "terminal.ansiRed": "#ff2e3f",
      // "terminal.ansiGreen": "#0dbe4e",
      // "terminal.ansiYellow": "#ffca00",
      // "terminal.ansiBlue": "#008cff",
      // "terminal.ansiMagenta": "#c635e4",
      // "terminal.ansiCyan": "#08c0ef",
      // "terminal.ansiWhite": "#c6c6c8",
      // "terminal.ansiBrightBlack": "#141415",
      // "terminal.ansiBrightRed": "#ff2e3f",
      // "terminal.ansiBrightGreen": "#0dbe4e",
      // "terminal.ansiBrightYellow": "#ffca00",
      // "terminal.ansiBrightBlue": "#008cff",
      // "terminal.ansiBrightMagenta": "#c635e4",
      // "terminal.ansiBrightCyan": "#08c0ef",
      // "terminal.ansiBrightWhite": "#c6c6c8",
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: {
          foreground: "var(--syntax-comment)",
        },
      },
      {
        scope: ["entity.other.attribute-name"],
        settings: {
          foreground: "var(--syntax-property)", // maybe attribute
        },
      },
      {
        scope: ["constant", "entity.name.constant", "variable.other.constant", "variable.language", "entity"],
        settings: {
          foreground: "var(--syntax-constant)",
        },
      },
      {
        scope: ["entity.name", "meta.export.default", "meta.definition.variable"],
        settings: {
          foreground: "var(--syntax-type)",
        },
      },
      {
        scope: ["meta.object.member"],
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: [
          "variable.parameter.function",
          "meta.jsx.children",
          "meta.block",
          "meta.tag.attributes",
          "entity.name.constant",
          "meta.embedded.expression",
          "meta.template.expression",
          "string.other.begin.yaml",
          "string.other.end.yaml",
        ],
        settings: {
          foreground: "var(--syntax-punctuation)",
        },
      },
      {
        scope: ["entity.name.function", "support.type.primitive"],
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: ["entity.name.function.wolfram", "variable.function.wolfram"],
        settings: {
          foreground: "var(--syntax-type)",
        },
      },
      {
        scope: ["support.function.builtin.wolfram", "support.function.experimental.wolfram"],
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: ["support.class.component"],
        settings: {
          foreground: "var(--syntax-type)",
        },
      },
      {
        scope: "keyword",
        settings: {
          foreground: "var(--syntax-keyword)",
        },
      },
      {
        scope: [
          "keyword.operator",
          "storage.type.function.arrow",
          "punctuation.separator.key-value.css",
          "entity.name.tag.yaml",
          "punctuation.separator.key-value.mapping.yaml",
        ],
        settings: {
          foreground: "var(--syntax-operator)",
        },
      },
      {
        scope: [
          "keyword.operator.wolfram",
          "keyword.operator.assignment.wolfram",
          "keyword.operator.arithmetic.wolfram",
        ],
        settings: {
          foreground: "var(--syntax-keyword)",
        },
      },
      {
        scope: "keyword.operator.Blank.wolfram",
        settings: {
          foreground: "var(--syntax-property)",
        },
      },
      {
        scope: ["storage", "storage.type"],
        settings: {
          foreground: "var(--syntax-keyword)",
        },
      },
      {
        scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: [
          "string",
          "punctuation.definition.string",
          "string punctuation.section.embedded source",
          "entity.name.tag",
        ],
        settings: {
          foreground: "var(--syntax-string)",
        },
      },
      {
        scope: "support",
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: ["support.type.object.module", "variable.other.object", "support.type.property-name.css"],
        settings: {
          foreground: "var(--syntax-object)",
        },
      },
      {
        scope: "meta.property-name",
        settings: {
          foreground: "var(--syntax-property)",
        },
      },
      {
        scope: "variable",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: "variable.other",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: [
          "invalid.broken",
          "invalid.illegal",
          "invalid.unimplemented",
          "invalid.deprecated",
          "message.error",
          "markup.deleted",
          "meta.diff.header.from-file",
          "punctuation.definition.deleted",
          "brackethighlighter.unmatched",
          "token.error-token",
        ],
        settings: {
          foreground: "var(--syntax-critical)",
        },
      },
      {
        scope: "carriage-return",
        settings: {
          foreground: "var(--syntax-keyword)",
        },
      },
      {
        scope: "string source",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: "string variable",
        settings: {
          foreground: "var(--syntax-constant)",
        },
      },
      {
        scope: [
          "source.regexp",
          "string.regexp",
          "string.regexp.character-class",
          "string.regexp constant.character.escape",
          "string.regexp source.ruby.embedded",
          "string.regexp string.regexp.arbitrary-repitition",
          "string.regexp constant.character.escape",
        ],
        settings: {
          foreground: "var(--syntax-regexp)",
        },
      },
      {
        scope: "support.constant",
        settings: {
          foreground: "var(--syntax-primitive)",
        },
      },
      {
        scope: [
          "constant.language.wolfram",
          "constant.numeric.wolfram",
          "donothighlight.constant.character.escape",
          "donothighlight.constant.character.escape.wolfram",
          "donothighlight.constant.character.escape.undocumented",
        ],
        settings: {
          foreground: "var(--syntax-constant)",
        },
      },
      {
        scope: "support.variable",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: "meta.module-reference",
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "punctuation.definition.list.begin.markdown",
        settings: {
          foreground: "var(--syntax-punctuation)",
        },
      },
      {
        scope: [
          "punctuation.section.brackets.wolfram",
          "punctuation.section.brackets.begin.wolfram",
          "punctuation.section.brackets.end.wolfram",
          "punctuation.section.braces.wolfram",
          "punctuation.section.braces.begin.wolfram",
          "punctuation.section.braces.end.wolfram",
          "punctuation.section.parens.wolfram",
          "punctuation.section.parens.begin.wolfram",
          "punctuation.section.parens.end.wolfram",
          "punctuation.separator",
        ],
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "symbol.unrecognized.wolfram",
        settings: {
          foreground: "var(--syntax-variable)",
        },
      },
      {
        scope: ["markup.heading", "markup.heading entity.name"],
        settings: {
          fontStyle: "bold",
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "markup.quote",
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "markup.italic",
        settings: {
          fontStyle: "italic",
          // foreground: "",
        },
      },
      {
        scope: "markup.bold",
        settings: {
          fontStyle: "bold",
          foreground: "var(--text-strong)",
        },
      },
      {
        scope: [
          "markup.raw",
          "markup.inserted",
          "meta.diff.header.to-file",
          "punctuation.definition.inserted",
          "markup.changed",
          "punctuation.definition.changed",
          "markup.ignored",
          "markup.untracked",
        ],
        settings: {
          foreground: "var(--text-base)",
        },
      },
      {
        scope: "meta.diff.range",
        settings: {
          fontStyle: "bold",
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "meta.diff.header",
        settings: {
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "meta.separator",
        settings: {
          fontStyle: "bold",
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "meta.output",
        settings: {
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "meta.export.default",
        settings: {
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: [
          "brackethighlighter.tag",
          "brackethighlighter.curly",
          "brackethighlighter.round",
          "brackethighlighter.square",
          "brackethighlighter.angle",
          "brackethighlighter.quote",
        ],
        settings: {
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: ["constant.other.reference.link", "string.other.link"],
        settings: {
          fontStyle: "underline",
          foreground: "var(--syntax-unknown)",
        },
      },
      {
        scope: "token.info-token",
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
      {
        scope: "token.warn-token",
        settings: {
          foreground: "var(--syntax-warning)",
        },
      },
      {
        scope: "token.debug-token",
        settings: {
          foreground: "var(--syntax-info)",
        },
      },
    ],
    semanticTokenColors: {
      comment: "var(--syntax-comment)",
      string: "var(--syntax-string)",
      number: "var(--syntax-constant)",
      regexp: "var(--syntax-regexp)",
      keyword: "var(--syntax-keyword)",
      variable: "var(--syntax-variable)",
      parameter: "var(--syntax-variable)",
      property: "var(--syntax-property)",
      function: "var(--syntax-primitive)",
      method: "var(--syntax-primitive)",
      type: "var(--syntax-type)",
      class: "var(--syntax-type)",
      namespace: "var(--syntax-type)",
      enumMember: "var(--syntax-primitive)",
      "variable.constant": "var(--syntax-constant)",
      "variable.defaultLibrary": "var(--syntax-unknown)",
    },
  } as unknown as ThemeRegistrationResolved)
})

function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&#10;/g, "\n")
    .replace(/&#13;/g, "\r")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#92;/g, "\\")
    .replace(/&#39;/g, "'")
    .replace(/&#124;/g, "|")
}

function stripEquationNumbers(math: string): string {
  return math
    .replace(/\\begin\{(align|equation|gather|eqnarray)\}/g, "\\begin{$1*}")
    .replace(/\\end\{(align|equation|gather|eqnarray)\}/g, "\\end{$1*}")
}

function stripMathHtml(text: string): string {
  return text
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim()
}

function escapeMathHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\\/g, "&#92;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\|/g, "&#124;")
}

function mathPlaceholder(math: string, style: "display" | "inline") {
  const tag = style === "display" ? "div" : "span"
  return `<${tag} data-opencode-math-style="${style}" data-opencode-math-tex="${escapeMathHtml(math)}"></${tag}>`
}

// Tracks how `prepareMarkdown` shifts line numbers, so annotated parsing can
// report line numbers in the coordinates of the ORIGINAL markdown instead of
// the prepared text. Display-math protection replaces a multi-line formula
// with a one-line placeholder plus blank lines, so the prepared text has more
// lines than the source.
type LineShiftEvent = { line: number; shift: number }
type LineTracker = { emitted: number; consumed: number; events: LineShiftEvent[] }

function countNewlines(text: string) {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

function protectDisplayMath(markdown: string, display: RegExp, empty: string, track?: LineTracker): string {
  let out = ""
  let from = 0
  let match: RegExpExecArray | null

  // Verbatim text passes through unchanged on both sides of the ledger.
  const account = (verbatim: string) => {
    if (!track || !verbatim) return
    const n = countNewlines(verbatim)
    track.emitted += n
    track.consumed += n
  }

  while ((match = display.exec(markdown))) {
    const math = match[1] ?? ""
    const clean = math.trim()
    if (!clean) {
      const verbatim = markdown.slice(from, match.index)
      account(verbatim)
      out += verbatim + empty
      from = match.index + match[0].length
      continue
    }

    const lineStart = markdown.lastIndexOf("\n", match.index - 1) + 1
    const linePrefix = markdown.slice(lineStart, match.index)
    const indented = /^[ \t]+$/.test(linePrefix)
    const placeholder = mathPlaceholder(clean, "display")

    if (indented) {
      // Keep list and blockquote indentation on the placeholder. Removing it
      // makes the following indented prose become an unrelated code block.
      const verbatim = markdown.slice(from, lineStart)
      account(verbatim)
      out += verbatim
      out += `${linePrefix}${placeholder}`
      // The placeholder is a block-level <div>, which opens a CommonMark raw
      // HTML block. That block only ends at a blank line, so any markdown on
      // the following lines of the same list item (links, emphasis, ...) would
      // be swallowed and emitted verbatim. When the formula stands alone on
      // its line(s), close the HTML block with a blank line.
      const tail = markdown.slice(match.index + match[0].length)
      const lineEnd = tail.indexOf("\n")
      const restOfLine = lineEnd === -1 ? tail : tail.slice(0, lineEnd)
      if (/^[ \t]*$/.test(restOfLine)) {
        out += "\n"
        if (track) track.emitted += 1
      }
      if (track) track.consumed += countNewlines(markdown.slice(lineStart, match.index + match[0].length))
      console.debug(`[markdown] protect display math indent=${linePrefix.length} tex=${clean.length}`)
    } else {
      const verbatim = markdown.slice(from, match.index)
      account(verbatim)
      out += verbatim
      out += `\n\n${placeholder}\n\n`
      if (track) {
        track.emitted += 4
        track.consumed += countNewlines(markdown.slice(match.index, match.index + match[0].length))
      }
      console.debug(`[markdown] protect display math indent=0 tex=${clean.length}`)
    }

    if (track && track.emitted !== track.consumed) {
      track.events.push({ line: track.emitted, shift: track.emitted - track.consumed })
    }
    from = match.index + match[0].length
  }

  if (from === 0) return markdown
  const rest = markdown.slice(from)
  account(rest)
  return out + rest
}

export function protectMathExpressions(markdown: string, track?: LineTracker): string {
  const block = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
  const parts = markdown.split(block)

  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        // Code fences pass through verbatim.
        if (track) {
          const n = countNewlines(part)
          track.emitted += n
          track.consumed += n
        }
        return part
      }
      const displayProtected = protectDisplayMath(part, /\$\$([\s\S]*?)\$\$/g, "$$$$", track)
      const bracketProtected = protectDisplayMath(displayProtected, /\\\[([\s\S]*?)\\\]/g, "\\[\\]", track)
      return protectInlineMath(bracketProtected)
    })
    .join("")
}

export function prepareMarkdown(markdown: string): string {
  // Autolinks run last: protected math is already an HTML tag by then, so a URL
  // inside math or a code span is skipped instead of being rewritten.
  return protectBareAutolinks(healPunctuationEmphasis(protectMathExpressions(markdown)))
}

// Same transformation as `prepareMarkdown`, but also returns a mapping from
// prepared-text line numbers (0-based) back to original-markdown line numbers
// (0-based). Only the display-math protection changes line counts; the inline
// passes (inline math, punctuation healing, autolinks) never insert newlines.
export function prepareMarkdownTracked(markdown: string): {
  text: string
  originLineOf(line: number): number
} {
  const track: LineTracker = { emitted: 0, consumed: 0, events: [] }
  const text = protectBareAutolinks(healPunctuationEmphasis(protectMathExpressions(markdown, track)))
  const events = track.events
  return {
    text,
    originLineOf(line: number) {
      let shift = 0
      for (const event of events) {
        if (event.line > line) break
        shift = event.shift
      }
      return line - shift
    },
  }
}

function escapedDollar(text: string, at: number) {
  let slash = 0
  for (let i = at - 1; i >= 0 && text[i] === "\\"; i--) slash++
  return slash % 2 === 1
}

function isHtmlTagNameChar(ch: string | undefined) {
  if (!ch) return false
  const code = ch.charCodeAt(0)
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    ch === "-"
  )
}

function isHtmlTagWs(ch: string | undefined) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f"
}

// Only skip well-formed HTML so math like $2M<n<60M^2$ is not treated as a tag.
// A previous heuristic treated "<" + letter as a tag and then scanned to any
// later ">", which swallowed the rest of the paragraph when a later $a>0$ existed.
function htmlTagEnd(text: string, at: number) {
  if (text[at] !== "<") return

  if (text.startsWith("<!--", at)) {
    const close = text.indexOf("-->", at + 4)
    if (close === -1) return
    return close + 2
  }

  const next = text[at + 1]
  if (!next) return
  if (next === "!" || next === "?") {
    const close = text.indexOf(">", at + 1)
    if (close === -1) return
    return close
  }

  let i = at + 1
  const closing = text[i] === "/"
  if (closing) i++

  if (!/[A-Za-z]/.test(text[i] ?? "")) return
  i++
  while (isHtmlTagNameChar(text[i])) i++

  if (closing) {
    while (isHtmlTagWs(text[i])) i++
    if (text[i] !== ">") return
    return i
  }

  const afterName = text[i]
  if (afterName === ">") return i
  // Self-closing only: <br/>. Math like $0<j/24<1$ is not a tag.
  if (afterName === "/") {
    i++
    while (isHtmlTagWs(text[i])) i++
    if (text[i] === ">") return i
    return
  }
  if (!isHtmlTagWs(afterName)) return

  while (i < text.length) {
    const ch = text[i]
    if (ch === ">") return i
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1)
      if (close === -1) return
      i = close + 1
      continue
    }
    i++
  }
}

function rawInlineMathEnd(text: string, from: number) {
  for (let i = from; i < text.length; i++) {
    const tag = htmlTagEnd(text, i)
    if (tag !== undefined) {
      i = tag
      continue
    }
    const ch = text[i]
    if (ch !== "$" || escapedDollar(text, i)) continue
    if (text[i + 1] === "$") {
      i++
      continue
    }
    if (/\s/.test(text[i - 1] ?? "")) continue
    return i
  }
}

function inlineCodeEnd(text: string, at: number) {
  if (text[at] !== "`") return
  let size = 0
  while (text[at + size] === "`") size++
  const mark = "`".repeat(size)
  const end = text.indexOf(mark, at + size)
  if (end === -1) return
  return end + size
}

function protectInlineMath(text: string) {
  let out = ""
  let from = 0

  for (let i = 0; i < text.length; i++) {
    const code = inlineCodeEnd(text, i)
    if (code) {
      out += text.slice(from, code)
      i = code - 1
      from = code
      continue
    }

    const tag = htmlTagEnd(text, i)
    if (tag !== undefined) {
      i = tag
      continue
    }
    const ch = text[i]
    if (ch !== "$" || escapedDollar(text, i)) continue
    if (text[i + 1] === "$") {
      const end = text.indexOf("$$", i + 2)
      if (end === -1) continue
      i = end + 1
      continue
    }
    if (/\s/.test(text[i + 1] ?? "")) continue

    const end = rawInlineMathEnd(text, i + 1)
    if (!end) continue

    const math = text.slice(i + 1, end)
    if (!math.trim()) continue
    out += text.slice(from, i)
    out += mathPlaceholder(math, "inline")
    i = end
    from = end + 1
  }

  if (from === 0) return text
  return out + text.slice(from)
}

const asciiPunctuation = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")

function isMarkdownPunctuation(ch: string | undefined) {
  if (!ch) return false
  if (asciiPunctuation.has(ch)) return true
  return /\p{P}/u.test(ch)
}

function isMarkdownWhitespace(ch: string | undefined) {
  if (!ch) return false
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "\f" ||
    ch === "\v" ||
    /\p{Zs}/u.test(ch)
  )
}

// CommonMark will not close **text：**Grok because the closer is preceded by
// punctuation and followed by a letter. Insert a comment so the closer is
// followed by punctuation and marked can pair it.
export function healPunctuationEmphasis(markdown: string): string {
  const block = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
  const parts = markdown.split(block)
  return parts.map((part, i) => (i % 2 === 1 ? part : healPunctuationEmphasisInText(part))).join("")
}

function healPunctuationEmphasisInText(text: string): string {
  const inserts: number[] = []
  const open: { mark: "*" | "_"; size: number }[] = []

  for (let i = 0; i < text.length; i++) {
    const code = inlineCodeEnd(text, i)
    if (code) {
      i = code - 1
      continue
    }

    const tag = htmlTagEnd(text, i)
    if (tag !== undefined) {
      i = tag
      continue
    }

    if (escapedDollar(text, i)) continue

    const mark = text[i]
    if (mark !== "*" && mark !== "_") continue

    let size = 1
    while (text[i + size] === mark) size++

    const before = text[i - 1]
    const after = text[i + size]
    const precededByWs = i === 0 || isMarkdownWhitespace(before)
    const followedByWs = after === undefined || isMarkdownWhitespace(after)
    const stuck = isMarkdownPunctuation(before) && after !== undefined && !followedByWs && !isMarkdownPunctuation(after)

    let remaining = size
    if (!precededByWs) {
      for (let j = open.length - 1; j >= 0 && remaining > 0; j--) {
        const opener = open[j]
        if (opener.mark !== mark) continue
        const used = Math.min(remaining, opener.size)
        remaining -= used
        opener.size -= used
        if (opener.size === 0) open.splice(j, 1)
        if (stuck) inserts.push(i + size)
        if (remaining === 0) break
      }
    }

    if (remaining > 0 && !followedByWs) {
      open.push({ mark, size: remaining })
    }

    i += size - 1
  }

  if (inserts.length === 0) return text
  const unique = [...new Set(inserts)].sort((a, b) => b - a)
  let out = text
  for (const at of unique) out = `${out.slice(0, at)}<!-- -->${out.slice(at)}`
  return out
}

// Wrap a bare URL that runs straight into CJK prose in an explicit "<...>"
// autolink so the parser stops the link at the URL. Rewriting the source (instead
// of the rendered <a>) keeps every render path consistent, including the desktop
// native parser, which does not go through the marked link renderer.
export function protectBareAutolinks(markdown: string): string {
  const block = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g
  const parts = markdown.split(block)
  return parts.map((part, i) => (i % 2 === 1 ? part : protectBareAutolinksInText(part))).join("")
}

function protectBareAutolinksInText(text: string) {
  let out = ""
  let from = 0
  let label = 0

  for (let i = 0; i < text.length; i++) {
    const code = inlineCodeEnd(text, i)
    if (code) {
      i = code - 1
      continue
    }

    const tag = htmlTagEnd(text, i)
    if (tag !== undefined) {
      i = tag
      continue
    }

    const ch = text[i]
    if (ch === "[") {
      label++
      continue
    }
    if (ch === "]") {
      if (label > 0) label--
      continue
    }

    if (!text.startsWith("https://", i) && !text.startsWith("http://", i)) continue

    // A URL after "(" or "[" is a markdown link destination, one after "<" is
    // already an autolink, and one inside "[...]" is a link label; adding
    // brackets would break all three.
    const before = text[i - 1]
    if (label > 0 || before === "(" || before === "[" || before === "<") continue

    const length = autolinkLength(text.slice(i))
    if (!length) continue

    out += `${text.slice(from, i)}<${text.slice(i, i + length)}>`
    from = i + length
    i = from - 1
  }

  if (from === 0) return text
  return out + text.slice(from)
}

function renderMathInText(text: string, output: MathOutput): string {
  const addMathTex = (html: string, latex: string, displayMode: boolean) => {
    return html.replace(
      /^<span class="([^"]*)"/,
      (_match, classes: string) =>
        `<span class="${classes}" data-opencode-math-style="${displayMode ? "display" : "inline"}" data-opencode-math-tex="${escapeMathHtml(latex)}"`,
    )
  }

  const render = (math: string, displayMode: boolean, fallback: string) => {
    try {
      const latex = unescapeHtmlEntities(math)
      const rendered = katex.renderToString(
        displayMode ? stripEquationNumbers(latex) : latex,
        katexOptions({
          displayMode,
          output,
        }),
      )
      return addMathTex(rendered, latex, displayMode)
    } catch {
      return fallback
    }
  }

  let result = text

  result = result.replace(
    /<(span|div) data-opencode-math-style="(inline|display)" data-opencode-math-tex="([^"]*)"[^>]*><\/\1>/g,
    (_, _tag, style: "inline" | "display", math) => {
      const displayMode = style === "display"
      return render(math, displayMode, displayMode ? `$$${math}$$` : `$${math}$`)
    },
  )

  result = result.replace(/<div data-opencode-math-style="display">([\s\S]*?)<\/div>/g, (_, math) =>
    render(math, true, `$$${math}$$`),
  )

  // Display math: <span data-math-style="display">...</span> (from comrak math_dollars)
  result = result.replace(/<span data-math-style="display">([\s\S]*?)<\/span>/g, (_, math) =>
    render(math, true, `$$${math}$$`),
  )

  // Inline math: <span data-math-style="inline">...</span> (from comrak math_dollars)
  result = result.replace(/<span data-math-style="inline">([\s\S]*?)<\/span>/g, (_, math) =>
    render(math, false, `$${math}$`),
  )

  // Fallback for native parsers that keep raw display delimiters.
  // Allow matches across parser-inserted tags, then strip tags from math payload.
  result = result.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    const clean = stripMathHtml(math)
    if (!clean) return `$$${math}$$`
    return render(clean, true, `$$${math}$$`)
  })
  result = result.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => {
    const clean = stripMathHtml(math)
    if (!clean) return `\\[${math}\\]`
    return render(clean, true, `\\[${math}\\]`)
  })

  return result
}

export function renderMathExpressions(html: string, output: MathOutput): string {
  // Split on code/pre/kbd tags to avoid processing their contents
  const codeBlockPattern = /(<(?:pre|code|kbd)[^>]*>[\s\S]*?<\/(?:pre|code|kbd)>)/gi
  const parts = html.split(codeBlockPattern)

  return parts
    .map((part, i) => {
      // Odd indices are the captured code blocks - leave them alone
      if (i % 2 === 1) return part
      // Process math only in non-code parts
      return renderMathInText(part, output)
    })
    .join("")
}

export function normalizeCodeLanguage(lang?: string): string {
  const value = lang?.trim().toLowerCase()
  if (!value) return "text"
  const aliases: Record<string, BundledLanguage> = {
    mathematica: "wolfram",
    mma: "wolfram",
    nb: "wolfram",
    wl: "wolfram",
    wls: "wolfram",
  }
  const normalized = aliases[value] ?? value
  return normalized in bundledLanguages ? normalized : "text"
}

export function preserveCodeLanguage(html: string, lang?: string): string {
  const language = lang?.trim().split(/\s+/)[0]
  if (!language || !/^[\w+-]+$/.test(language)) return html
  return html.replace("<code>", `<code class="language-${language}">`)
}

async function highlightCodeBlocks(html: string): Promise<string> {
  const codeBlockRegex = /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
  const matches = [...html.matchAll(codeBlockRegex)]
  if (matches.length === 0) return html

  const timeoutMs = 6_000
  try {
    const result = await Promise.race([
      (async () => {
        const highlighter = await getSharedHighlighter({
          themes: ["OpenCode"],
          langs: [],
          preferredHighlighter: "shiki-wasm",
        })

        let output = html
        for (const match of matches) {
          const [fullMatch, lang, escapedCode] = match
          const code = unescapeHtmlEntities(escapedCode)

          const language = normalizeCodeLanguage(lang)
          if (!highlighter.getLoadedLanguages().includes(language)) {
            await highlighter.loadLanguage(language as BundledLanguage)
          }

          const highlighted = highlighter.codeToHtml(code, {
            lang: language,
            theme: "OpenCode",
            tabindex: false,
          })
          output = output.replace(fullMatch, () => preserveCodeLanguage(highlighted, lang))
        }
        return output
      })(),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(html), timeoutMs),
      ),
    ])
    return result
  } catch {
    return html
  }
}

export type NativeMarkdownParser = (markdown: string) => Promise<string>

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: (props: { nativeParser?: NativeMarkdownParser; mathOutput?: MathOutput }) => {
    const output = props.mathOutput ?? "htmlAndMathml"
    const native = props.nativeParser

    const highlightTimeoutMs = 6_000
    const plainCode = (code: string, lang?: string) => {
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      return `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escaped}</code></pre>`
    }

    const highlight = async (code: string, lang?: string) => {
      try {
        const result = await Promise.race([
          (async () => {
            const highlighter = await getSharedHighlighter({
              themes: ["OpenCode"],
              langs: [],
              preferredHighlighter: "shiki-wasm",
            })
            const value = normalizeCodeLanguage(lang)
            if (!highlighter.getLoadedLanguages().includes(value)) {
              await highlighter.loadLanguage(value as BundledLanguage)
            }
            return preserveCodeLanguage(
              highlighter.codeToHtml(code, {
                lang: value,
                theme: "OpenCode",
                tabindex: false,
              }),
              lang,
            )
          })(),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve(plainCode(code, lang)), highlightTimeoutMs),
          ),
        ])
        return result
      } catch {
        return plainCode(code, lang)
      }
    }

    const linkRenderer = {
      renderer: {
        link({ href, title, text }: { href: string; title?: string | null; text: string }) {
          const normalized = href ? normalizeAutolink(href, text) : undefined
          const safeHref = normalized?.href ?? href
          const safeText = normalized?.text ?? text
          const titleAttr = title ? ` title="${title}"` : ""
          return `<a href="${safeHref}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${safeText}</a>`
        },
      },
    }

    const liteParser = new Marked(linkRenderer)
    const noMathParser = new Marked(
      linkRenderer,
      markedShiki({
        async highlight(code, lang) {
          return highlight(code, lang)
        },
      }),
    )

    // Full parser with shiki highlighting — used for final render
    const fullParser = new Marked(
      linkRenderer,
      markedKatex({
        ...katexOptions({ output }),
        output,
        nonStandard: true,
      }),
      markedShiki({
        async highlight(code, lang) {
          return highlight(code, lang)
        },
      }),
    )

    // Fast parser skips both shiki and KaTeX so first paint stays cheap.
    // The renderer upgrades to the full parser later when needed.
    const fastParser = new Marked(linkRenderer)

    // Renders markdown with a `data-ml` marker span before each top-level
    // block, carrying the block's first source line. The Markdown component
    // converts these markers into `data-source-line` attributes on the
    // rendered elements after DOM insertion, which lets the file preview
    // scroll a rendered block to its source-line anchor. Only the local
    // full pipeline can do this (the native parser is a black box and the
    // lite/fast parsers tokenize differently), so this is defined on both
    // context branches and callers fall back to plain parsing when the stage
    // is not "full".
    const parseAnnotated = async (markdown: string): Promise<string> => {
      // Line numbers must be reported in original-file coordinates: anchors
      // like #L638 refer to the source file, while the lexer runs on the
      // prepared text whose display-math protection inserts extra lines.
      const prepared = prepareMarkdownTracked(markdown)
      const tokens = fullParser.lexer(prepared.text) as unknown as Token[]
      const defs = tokens.filter((token) => token.type === "def").map((token) => token.raw).join("")
      let html = ""
      let line = 1
      for (const token of tokens) {
        if (token.type !== "space" && token.type !== "def") {
          const sourceLine = prepared.originLineOf(line - 1) + 1
          html += `<span data-ml="${sourceLine}"></span>`
          // Reference-style link definitions may live in any block, so they
          // are prepended to every block (they render to nothing).
          const source = defs ? `${defs}\n\n${token.raw}` : token.raw
          const block = await fullParser.parse(source)
          html += renderMathExpressions(block, output)
        }
        line += token.raw.split("\n").length - 1
      }
      return html
    }

    if (native) {
      return {
        async parse(markdown: string): Promise<string> {
          const html = await native(prepareMarkdown(markdown))
          const withMath = renderMathExpressions(html, output)
          return highlightCodeBlocks(withMath)
        },
        async parseNoMath(markdown: string): Promise<string> {
          const html = await native(prepareMarkdown(markdown))
          return highlightCodeBlocks(html)
        },
        async parseFast(markdown: string): Promise<string> {
          // Keep the first paint in-process; native IPC is too expensive per message.
          return fastParser.parse(prepareMarkdown(markdown))
        },
        async parseLite(markdown: string): Promise<string> {
          // Large previews still mount with the local lightweight parser, then upgrade later.
          return liteParser.parse(prepareMarkdown(markdown))
        },
        parseAnnotated,
        renderMath(html: string) {
          return renderMathExpressions(html, output)
        },
        async highlight(code: string, lang?: string) {
          return highlight(code, lang)
        },
      }
    }

    return {
      async parse(markdown: string): Promise<string> {
        const html = await fullParser.parse(prepareMarkdown(markdown))
        return renderMathExpressions(html, output)
      },
      parseAnnotated,
      async parseNoMath(markdown: string): Promise<string> {
        return noMathParser.parse(prepareMarkdown(markdown))
      },
      async parseFast(markdown: string): Promise<string> {
        return fastParser.parse(prepareMarkdown(markdown))
      },
      async parseLite(markdown: string): Promise<string> {
        // The lite path skips KaTeX/shiki so large file previews can mount before block-by-block upgrades run.
        return liteParser.parse(prepareMarkdown(markdown))
      },
      renderMath(html: string) {
        return renderMathExpressions(html, output)
      },
      async highlight(code: string, lang?: string) {
        return highlight(code, lang)
      },
    }
  },
})
