import { marked, type Tokens } from "marked"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live"
}

function refs(text: string) {
  return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

type BlockScan = {
  math: boolean
  codeSpan: number
  fenceChar: string
  fenceSize: number
}

function scanLine(line: string, state: BlockScan) {
  const fence = state.codeSpan === 0 && !state.math ? line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1] : undefined
  if (fence) {
    if (!state.fenceChar) {
      state.fenceChar = fence[0]!
      state.fenceSize = fence.length
    } else if (fence[0] === state.fenceChar && fence.length >= state.fenceSize) {
      state.fenceChar = ""
      state.fenceSize = 0
    }
    return
  }
  if (state.fenceChar) return

  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++
      continue
    }
    if (line[i] === "`") {
      let size = 1
      while (line[i + size] === "`") size++
      if (state.codeSpan === 0) state.codeSpan = size
      else if (state.codeSpan === size) state.codeSpan = 0
      i += size - 1
      continue
    }
    if (state.codeSpan !== 0 || line[i] !== "$" || line[i + 1] !== "$") continue
    state.math = !state.math
    i++
  }
}

function openDisplayMath(text: string) {
  const state: BlockScan = { math: false, codeSpan: 0, fenceChar: "", fenceSize: 0 }
  for (const line of text.split(/\r?\n/)) scanLine(line, state)
  return state.math
}

function heal(text: string) {
  if (openDisplayMath(text)) return text
  // TeX comparisons such as \sum_{i<j} are not unfinished HTML tags.
  // Removing them truncates every subsequent paragraph until the next open formula.
  const healed = remend(text, { linkMode: "text-only", htmlTags: false })
  if (healed.length < text.length && /\$\$|\\\[/.test(text)) {
    console.debug(`[markdown-stream] healed shorter source=${text.length} result=${healed.length}`)
  }
  if (!healed.startsWith(text)) return healed
  const suffix = healed.slice(text.length)
  if (!suffix.endsWith("$$")) return healed
  return text + suffix.slice(0, -2)
}

export function stream(text: string, live: boolean) {
  if (!live) return [{ raw: text, src: text, mode: "full" }] satisfies Block[]
  const src = heal(text)
  if (refs(text)) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== "space")
  if (tail < 0) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  const last = tokens[tail]
  if (!last || last.type !== "code") return [{ raw: text, src, mode: "live" }] satisfies Block[]
  const code = last as Tokens.Code
  if (!open(code.raw)) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  const head = tokens
    .slice(0, tail)
    .map((token) => token.raw)
    .join("")
  if (!head) return [{ raw: code.raw, src: code.raw, mode: "live" }] satisfies Block[]
  return [
    { raw: head, src: heal(head), mode: "live" },
    { raw: code.raw, src: code.raw, mode: "live" },
  ] satisfies Block[]
}

export type StreamTail = "text" | "fence" | "math"

// A link-definition line. Footnote-style `[^x]:` is excluded: the base marked
// lexer treats it as ordinary text, so it must stay visible rather than be
// classified as an invisible definition.
const DEF_LINE = /^[ \t]{0,3}\[[^\]^][^\]]*\]:/

export type StreamingSplit = {
  chunks: string[]
  live: StreamTail
  /** Link-definition lines found outside fences and `$$` math. */
  defs: string[]
}

/**
 * Splits `text` into top-level chunks at blank lines that sit outside fenced
 * code blocks and `$$` display math — a single linear scan, no tokenization.
 *
 * Streaming renders every chunk through the full parser once and keeps the
 * results; appended text only lands in the last chunk, so per-frame work stays
 * proportional to the unfinished tail instead of the whole document. Boundaries
 * therefore only have to be *stable*, not identical to `marked`'s blocks: a
 * loose list split in two renders as two lists while streaming and merges back
 * in the final non-streaming render.
 */
export function splitStreaming(text: string): StreamingSplit {
  const chunks: string[] = []
  const defs: string[] = []
  const state: BlockScan = { math: false, codeSpan: 0, fenceChar: "", fenceSize: 0 }
  let start = 0
  let line = 0
  while (line <= text.length) {
    const nl = text.indexOf("\n", line)
    const end = nl < 0 ? text.length : nl
    const slice = text.slice(line, end)
    // A def line inside a fence or display math is literal text, not a link
    // definition — collect it only while the scan is clean.
    if (!state.fenceChar && !state.math && DEF_LINE.test(slice)) defs.push(slice)
    // A blank line outside a fence/math ends the current chunk; runs of blank
    // lines attach to whatever precedes them so whitespace-only chunks are
    // never emitted.
    if (!state.fenceChar && !state.math && /^[ \t]*\r?$/.test(slice)) {
      const next = nl < 0 ? end : nl + 1
      if (/\S/.test(text.slice(start, end))) chunks.push(text.slice(start, next))
      start = next
    } else {
      scanLine(slice, state)
    }
    line = nl < 0 ? text.length + 1 : nl + 1
  }
  if (start < text.length) chunks.push(text.slice(start))
  return {
    chunks,
    live: state.fenceChar ? "fence" : state.math ? "math" : "text",
    defs,
  }
}

export type StreamRenderState = {
  /** The exact per-chunk parse inputs the cached html was produced from. */
  inputs: string[]
  /** Sanitized html per chunk. */
  htmls: string[]
}

function isDefChunk(src: string) {
  let def = false
  for (const line of src.split("\n")) {
    if (!line.trim()) continue
    if (!DEF_LINE.test(line)) return false
    def = true
  }
  return def
}

// Marks chunk inputs that are pure link definitions and render to nothing.
// NUL cannot appear in markdown source, so it cannot collide with real text.
const DEF_INPUT = "\u0000def"

/**
 * Renders streamed markdown incrementally: `render` runs once per new or
 * changed chunk; chunks whose effective parse input is unchanged reuse the
 * html stored in `state`.
 *
 * Link definitions may appear anywhere and resolve forward references, so the
 * def lines collected across all chunks are prepended to every non-def chunk —
 * the same trick `parseAnchoredMarkdown` uses. A def arriving late therefore
 * re-renders earlier chunks once (their inputs change), which is exactly what
 * resolving those references requires.
 *
 * `heal` runs per chunk instead of over the whole text: inline constructs
 * cannot span blank-line boundaries, so chunk-level healing is equivalent —
 * except for the tail, which stays raw while it is still inside an unclosed
 * fence or `$$` math (matching `stream`'s live-tail contract).
 */
export async function renderStreaming(
  text: string,
  state: StreamRenderState | undefined,
  render: (src: string) => string | Promise<string>,
): Promise<{ html: string; state: StreamRenderState }> {
  const { chunks, live, defs } = splitStreaming(text)
  if (!chunks.length) return { html: "", state: { inputs: [], htmls: [] } }

  const prefix = defs.length ? `${defs.join("\n")}\n\n` : ""

  const inputs = chunks.map((src, i) => {
    if (isDefChunk(src)) return `${DEF_INPUT}${src}`
    // Trim trailing blank lines: they only appear once a block completes, and
    // dropping them keeps a finished chunk's parse input identical to what it
    // was while the block was still growing.
    const trimmed = src.trimEnd()
    const healed = i === chunks.length - 1 && live !== "text" ? trimmed : heal(trimmed)
    return prefix + healed
  })

  let common = 0
  while (common < inputs.length && inputs[common] === state?.inputs[common]) common++
  const htmls = state?.htmls.slice(0, common) ?? []
  for (let i = common; i < inputs.length; i++) {
    const src = inputs[i]!
    htmls.push(src.startsWith(DEF_INPUT) ? "" : await render(src))
  }
  return { html: htmls.join(""), state: { inputs, htmls } }
}
