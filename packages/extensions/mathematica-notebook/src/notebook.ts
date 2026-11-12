// Parse structure only. Never evaluate notebook contents or front-end callbacks.
type Node = { start: number; end: number; depth: number; head?: string; open?: number; string?: boolean }
type Spans = Map<number, number>
export type Cell = {
  index: number
  style: string
  text: string
  editable: boolean
  runnable: boolean
  raw: string
  start: number
  end: number
}
export type Notebook = { cells: Cell[]; insertAt: number; empty: boolean }
export type Edit = { index: number; text: string }

// Kernel-generated styles stay read-only even when their content is plain
// text; editing them would silently rewrite saved output.
const READONLY_STYLES = new Set(["Output", "Print", "Message", "Echo"])

export class NotebookParseError extends Error {
  readonly line: number
  readonly column: number

  constructor(
    message: string,
    source: string,
    readonly offset: number,
  ) {
    const before = source.slice(0, offset)
    const line = before.split("\n").length
    const column = offset - before.lastIndexOf("\n")
    super(`${message} at line ${line}, column ${column}`)
    this.name = "NotebookParseError"
    this.line = line
    this.column = column
  }
}

export function quote(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  )
}

function decode(value: string) {
  return value.replace(
    /\\(?:\r?\n|\:([\da-f]{4})|\.([\da-f]{2})|([0-7]{3})|(["\\nrtbf]))/gi,
    (_, hex, byte, oct, escaped) => {
      if (hex || byte) return String.fromCharCode(parseInt(hex ?? byte, 16))
      if (oct) return String.fromCharCode(parseInt(oct, 8))
      if (!escaped) return ""
      return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[escaped] ?? escaped
    },
  )
}

function trivia(source: string, position: number, end: number, spans: Spans): number {
  while (position < end) {
    if (/\s/.test(source[position])) {
      position++
      continue
    }
    if (source.slice(position, position + 2) !== "(*") break
    const cached = spans.get(position)
    if (cached !== undefined) {
      position = cached
      continue
    }
    const start = position
    let depth = 1
    position += 2
    while (position < end && depth) {
      const pair = source.slice(position, position + 2)
      if (pair === "(*") {
        depth++
        position += 2
      } else if (pair === "*)") {
        depth--
        position += 2
      } else position++
    }
    if (depth) throw new Error("Unterminated notebook comment")
    spans.set(start, position)
  }
  return position
}

function stringEnd(source: string, start: number, end: number, spans: Spans): number {
  const cached = spans.get(start)
  if (cached !== undefined) return cached
  for (let i = start + 1; i < end; i++) {
    if (source[i] === "\\") {
      i++
      continue
    }
    if (source[i] === '"') {
      spans.set(start, i + 1)
      return i + 1
    }
  }
  throw new Error("Unterminated notebook string")
}

function groupEnd(source: string, start: number, end: number, spans: Spans): number {
  const cached = spans.get(start)
  if (cached !== undefined) return cached
  const stack: { start: number; close: string }[] = []
  for (let i = start; i < end; i++) {
    if (source[i] === '"') {
      i = stringEnd(source, i, end, spans) - 1
      continue
    }
    if (source.slice(i, i + 2) === "(*") {
      i = trivia(source, i, end, spans) - 1
      continue
    }
    const pair = source.slice(i, i + 2)
    const char = source[i]
    if (pair === "<|") {
      stack.push({ start: i, close: "|>" })
      i++
    } else if (pair === "|>") {
      const open = stack.pop()
      if (open?.close !== "|>") throw new NotebookParseError("Unbalanced notebook delimiters", source, i)
      i++
      spans.set(open.start, i + 1)
      if (!stack.length) return i + 1
    } else if ("[{(".includes(char)) {
      stack.push({ start: i, close: ({ "[": "]", "{": "}", "(": ")" } as Record<string, string>)[char] })
    } else if ("]})".includes(char)) {
      const open = stack.pop()
      if (open?.close !== char) throw new NotebookParseError("Unbalanced notebook delimiters", source, i)
      spans.set(open.start, i + 1)
      if (!stack.length) return i + 1
    }
  }
  throw new NotebookParseError("Unbalanced notebook delimiters", source, end)
}

function parts(source: string, start: number, end: number, spans: Spans, limit = Infinity): [number, number][] {
  const result: [number, number][] = []
  let from = start
  for (let i = start; i < end; i++) {
    if (source[i] === '"') {
      i = stringEnd(source, i, end, spans) - 1
      continue
    }
    if (source.slice(i, i + 2) === "(*") {
      i = trivia(source, i, end, spans) - 1
      continue
    }
    const char = source[i]
    if ("[{(".includes(char) || source.slice(i, i + 2) === "<|") i = groupEnd(source, i, end, spans) - 1
    else if ("]})".includes(char) || source.slice(i, i + 2) === "|>")
      throw new NotebookParseError("Unbalanced notebook delimiters", source, i)
    else if (char === ",") {
      result.push([from, i])
      if (result.length === limit) return result
      from = i + 1
    }
  }
  if (trivia(source, from, end, spans) < end) result.push([from, end])
  return result
}

function node(source: string, start: number, end: number, spans: Spans, depth = 0): Node {
  if (depth > 128) throw new Error("Notebook nesting is too deep")
  start = trivia(source, start, end, spans)
  while (end > start && /\s/.test(source[end - 1])) end--
  const result: Node = { start, end, depth }
  if (source[start] === '"') {
    const close = stringEnd(source, start, end, spans)
    if (trivia(source, close, end, spans) === end) {
      result.end = close
      result.string = true
      return result
    }
  }
  const call = /^([\w$`]+)\s*\[/.exec(source.slice(start, end))
  const list = source[start] === "{"
  if (list || call) {
    const open = start + (list ? 0 : call![0].length - 1)
    const close = groupEnd(source, open, end, spans)
    // A leading call can be one factor, a curried head or a Part expression.
    // Only descend when this call/list occupies the entire source span.
    if (trivia(source, close, end, spans) !== end) return result
    result.end = close
    result.head = list ? "List" : call![1]
    result.open = open
  }
  return result
}

function args(source: string, value: Node, spans: Spans, limit = Infinity): Node[] {
  if (value.open === undefined) return []
  return parts(source, value.open + 1, value.end - 1, spans, limit).map(([start, end]) =>
    node(source, start, end, spans, value.depth + 1),
  )
}

function stringValue(source: string, value: Node | undefined): string | undefined {
  if (value?.string) return decode(source.slice(value.start + 1, value.end - 1))
}

// A bounded, structural reader for the preview worker. Interpretation payloads
// and callbacks remain opaque; callers choose exactly which arguments to visit.
export function boxReader(source: string) {
  const spans: Spans = new Map()
  return {
    root: () => node(source, 0, source.length, spans),
    args: (value: Node, limit = 128) => args(source, value, spans, limit),
    string: (value: Node) => stringValue(source, value),
    raw: (value: Node) => source.slice(value.start, value.end),
    option: (value: Node, name: string) => {
      if (source.slice(value.start, value.start + 2) !== "<|") return
      for (const [start, end] of parts(source, value.start + 2, value.end - 2, spans, 64)) {
        const from = trivia(source, start, end, spans)
        if (source[from] !== '"') continue
        const close = stringEnd(source, from, end, spans)
        if (decode(source.slice(from + 1, close - 1)) !== name) continue
        const arrow = trivia(source, close, end, spans)
        if (source.slice(arrow, arrow + 2) === "->") return node(source, arrow + 2, end, spans)
      }
    },
  }
}
export type BoxNode = Node

function content(source: string, value: Node | undefined, spans: Spans): { text: string; safe: boolean } {
  if (!value) return { text: "", safe: false }
  const text = stringValue(source, value)
  if (text !== undefined) return { text: text === "\\[IndentingNewLine]" ? "\n" : text, safe: true }
  // Only inspect heads whose children contribute visible text. Unknown boxes and
  // unused options stay opaque; groupEnd already validated their full structure.
  if (value.head === "BoxData") return content(source, args(source, value, spans, 1)[0], spans)
  if (value.head === "RowBox") {
    const first = args(source, value, spans, 1)[0]
    if (first?.head === "List") {
      const items = args(source, first, spans).map((item) => content(source, item, spans))
      return { text: items.map((item) => item.text).join(""), safe: items.every((item) => item.safe) }
    }
  }
  if (value.head === "TextData" || value.head === "StyleBox" || value.head === "FormBox") {
    const first = args(source, value, spans, 1)[0]
    const text =
      first?.head === "List"
        ? args(source, first, spans)
            .map((item) => content(source, item, spans).text)
            .join("")
        : content(source, first, spans).text
    return { text, safe: false }
  }
  // Unknown box types are opaque, not guessed into potentially different code.
  return { text: "", safe: false }
}

export function parseNotebook(source: string, options?: { preview?: boolean }): Notebook {
  // Index each string/comment/delimited group once. Descendants skip cached
  // spans instead of rescanning large outputs at every nesting level.
  const spans: Spans = new Map()
  const start = trivia(source, 0, source.length, spans)
  // Ignore trailing cache comments, common in Mathematica-generated .nb files.
  const match = /^Notebook\s*\[/.exec(source.slice(start))
  if (!match) throw new Error("Expected a textual Mathematica Notebook[...] file")
  const end = groupEnd(source, start + match[0].length - 1, source.length, spans)
  if (trivia(source, end, source.length, spans) !== source.length)
    throw new Error("Unexpected data after Notebook expression")
  // Materialize only structural children and text-bearing boxes, never the
  // complete AST of opaque outputs or notebook/cell options.
  const root = node(source, start, end, spans)
  const list = args(source, root, spans, 1)[0]
  if (list?.head !== "List") throw new Error("Notebook cells must be a list")
  const cells: Cell[] = []
  const visit = (entry: Node) => {
    if (entry.head !== "Cell") return
    const [first, styleNode] = args(source, entry, spans, 2)
    if (first?.head === "CellGroupData") {
      const group = args(source, first, spans, 1)[0]
      if (group) args(source, group, spans).forEach(visit)
      return
    }
    if (!first) return
    const style = stringValue(source, styleNode) ?? "Text"
    let rendered: { text: string; safe: boolean }
    try {
      rendered = content(source, first, spans)
    } catch (error) {
      // The structural scan already validated delimiters. Excessively deep
      // display content can be preserved locally without rejecting other cells.
      if (!options?.preview || !(error instanceof Error) || error.message !== "Notebook nesting is too deep")
        throw error
      rendered = { text: "", safe: false }
    }
    cells.push({
      index: cells.length,
      style,
      text: rendered.text || (rendered.safe ? "" : source.slice(first.start, first.end)),
      editable: rendered.safe && !READONLY_STYLES.has(style),
      runnable: style === "Input" || style === "Code",
      raw: source.slice(entry.start, entry.end),
      start: first.start,
      end: first.end,
    })
  }
  const entries = args(source, list, spans)
  entries.forEach(visit)
  return { cells, insertAt: list.end - 1, empty: entries.length === 0 }
}

// CacheID is a file-header comment, never cell text or a nested comment fragment.
export function removeNotebookCacheId(source: string): string {
  const spans: Spans = new Map()
  trivia(source, 0, source.length, spans)
  const chunks: string[] = []
  let position = 0
  for (const [start, end] of spans) {
    if (!/^\(\*\s*CacheID:\s*\d+\s*\*\)$/.test(source.slice(start, end))) continue
    chunks.push(source.slice(position, start))
    position = end
  }
  chunks.push(source.slice(position))
  return chunks.join("")
}

export function editNotebook(
  source: string,
  edits: Edit[],
  append?: { style: "Input" | "Text"; text: string },
  parsed?: Notebook,
): string {
  // Reuse only a model parsed from this exact source snapshot.
  const notebook = parsed ?? parseNotebook(source)
  const seen = new Set<number>()
  const patches = edits.map((edit) => {
    const cell = notebook.cells[edit.index]
    if (!cell || seen.has(edit.index) || typeof edit.text !== "string")
      throw new Error("Invalid, duplicate or unsupported cell edit")
    const input = cell.style === "Input" || cell.style === "Code"
    // Non-editable Input/Code content (box markup) patches verbatim — the
    // caller edits the raw BoxData expression, and the whole-file re-parse
    // after patching rejects malformed results.
    if (!cell.editable && !input) throw new Error("Invalid, duplicate or unsupported cell edit")
    seen.add(edit.index)
    return {
      start: cell.start,
      end: cell.end,
      text: !cell.editable ? edit.text : input ? `BoxData[${quote(edit.text)}]` : quote(edit.text),
    }
  })
  if (append)
    patches.push({
      start: notebook.insertAt,
      end: notebook.insertAt,
      text: `${notebook.empty ? "" : ","}\nCell[${append.style === "Input" ? `BoxData[${quote(append.text)}]` : quote(append.text)}, ${quote(append.style)}]\n`,
    })
  const chunks: string[] = []
  let position = 0
  for (const patch of patches.sort((a, b) => a.start - b.start)) {
    chunks.push(source.slice(position, patch.start), patch.text)
    position = patch.end
  }
  chunks.push(source.slice(position))
  return chunks.join("")
}
