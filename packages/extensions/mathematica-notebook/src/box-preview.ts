import { boxReader, type BoxNode } from "./notebook"
import { PREVIEW_LIMITS as L, type Box, type Preview } from "./preview-protocol"

const names: Record<string, string> = {
  Alpha: "\u0391",
  Beta: "\u0392",
  Gamma: "\u0393",
  Delta: "\u0394",
  Epsilon: "\u0395",
  Theta: "\u0398",
  Lambda: "\u039b",
  Xi: "\u039e",
  Pi: "\u03a0",
  Sigma: "\u03a3",
  Phi: "\u03a6",
  Psi: "\u03a8",
  Omega: "\u03a9",
  alpha: "\u03b1",
  beta: "\u03b2",
  gamma: "\u03b3",
  delta: "\u03b4",
  CurlyTheta: "\u03d1",
  CurlyPhi: "\u03d5",
  CurlyEpsilon: "\u03b5",
  CurlyPi: "\u03d6",
  ExponentialE: "\u2147",
  WeierstrassP: "\u2118",
  Cross: "\u00d7",
  ImaginaryI: "\u2148",
  ImaginaryJ: "\u2149",
  Infinity: "\u221e",
  Rule: "\u2192",
  RuleDelayed: "\u29f4",
  Equal: "=",
  NotEqual: "\u2260",
  LessEqual: "\u2264",
  GreaterEqual: "\u2265",
  Times: "\u00d7",
  CenterDot: "\u00b7",
  InvisibleTimes: "\u2062",
  InvisibleSpace: "\u200b",
  ThinSpace: "\u2009",
  VeryThinSpace: "\u200a",
  MediumSpace: "\u205f",
  ThickSpace: "\u2004",
  IndentingNewLine: "\n",
  NewLine: "\n",
  Integral: "\u222b",
  Sum: "\u2211",
  Product: "\u220f",
  PartialD: "\u2202",
  Del: "\u2207",
  DifferentialD: "\u2146",
  Element: "\u2208",
  NotElement: "\u2209",
  Union: "\u222a",
  Intersection: "\u2229",
  And: "\u2227",
  Or: "\u2228",
  Not: "\u00ac",
  LeftAngleBracket: "\u27e8",
  RightAngleBracket: "\u27e9",
  LeftDoubleBracket: "\u301a",
  RightDoubleBracket: "\u301b",
  LeftFloor: "\u230a",
  RightFloor: "\u230b",
  LeftCeiling: "\u2308",
  RightCeiling: "\u2309",
  Ellipsis: "\u2026",
  HorizontalEllipsis: "\u2026",
  VerticalEllipsis: "\u22ee",
  FilledSquare: "\u25a0",
  Conjugate: "*",
  Transpose: "\u1d40",
  ConjugateTranspose: "\u2020",
  Degree: "\u00b0",
  PlusMinus: "\u00b1",
  ScriptCapitalB: "\u212c",
  ScriptCapitalE: "\u2130",
  ScriptCapitalF: "\u2131",
  ScriptCapitalH: "\u210b",
  ScriptCapitalI: "\u2110",
  ScriptCapitalL: "\u2112",
  ScriptCapitalM: "\u2133",
  ScriptCapitalR: "\u211b",
  ScriptE: "\u212f",
  ScriptG: "\u210a",
  ScriptO: "\u2134",
  DoubleStruckCapitalC: "\u2102",
  DoubleStruckCapitalH: "\u210d",
  DoubleStruckCapitalN: "\u2115",
  DoubleStruckCapitalP: "\u2119",
  DoubleStruckCapitalQ: "\u211a",
  DoubleStruckCapitalR: "\u211d",
  DoubleStruckCapitalZ: "\u2124",
}
for (const [i, name] of [
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "Epsilon",
  "Zeta",
  "Eta",
  "Theta",
  "Iota",
  "Kappa",
  "Lambda",
  "Mu",
  "Nu",
  "Xi",
  "Omicron",
  "Pi",
  "Rho",
  "FinalSigma",
  "Sigma",
  "Tau",
  "Upsilon",
  "Phi",
  "Chi",
  "Psi",
  "Omega",
].entries()) {
  names[name] = String.fromCodePoint(0x3b1 + i)
  if (name !== "FinalSigma") names[`Capital${name}`] = String.fromCodePoint(0x391 + i)
}

export function namedCharacters(text: string) {
  return text.replace(/\\\[([A-Za-z]+)\]/g, (original, name: string) => {
    if (names[name]) return names[name]
    const script = /^(Script|DoubleStruck)(Capital)?([A-Z])$/.exec(name)
    if (!script) return original
    const base = script[1] === "Script" ? (script[2] ? 0x1d49c : 0x1d4b6) : script[2] ? 0x1d538 : 0x1d552
    return String.fromCodePoint(base + script[3].charCodeAt(0) - 65)
  })
}

const layouts: Record<string, [Box["kind"], number]> = {
  FractionBox: ["frac", 2],
  SuperscriptBox: ["sup", 2],
  SubscriptBox: ["sub", 2],
  SubsuperscriptBox: ["subsup", 3],
  SqrtBox: ["sqrt", 1],
  RadicalBox: ["root", 2],
  OverscriptBox: ["over", 2],
  UnderscriptBox: ["under", 2],
  UnderoverscriptBox: ["underover", 3],
}
const wrappers = new Set([
  "BoxData",
  "Cell",
  "FormBox",
  "TagBox",
  "InterpretationBox",
  "TooltipBox",
  "ButtonBox",
  "PaneBox",
  "FrameBox",
  "ItemBox",
  "AdjustmentBox",
])

// RowBox is a sequence, not a grouping construct. Flatten sequences and lift
// explicit line breaks before MathML layout (mtext itself does not break lines).
function flow(children: Box[]): Box {
  const lines: Box[][] = [[]]
  let clipped = false
  const newline = () => {
    if (lines.length >= 128) {
      clipped = true
      return
    }
    lines.push([])
  }
  const append = (box: Box) => {
    if (clipped) return
    if (box.kind === "row") {
      for (const child of box.children ?? []) append(child)
      return
    }
    if (box.kind === "lines") {
      for (const [i, line] of (box.children ?? []).entries()) {
        if (i) newline()
        append(line)
      }
      return
    }
    const parts = box.kind === "text" ? (box.text ?? "").split("\n") : undefined
    if (parts && parts.length > 1) {
      for (const [i, part] of parts.entries()) {
        if (i) newline()
        if (part) append({ kind: "text", text: part })
      }
      return
    }
    const line = lines.at(-1)!
    const last = line.at(-1)
    if (last?.kind === "text" && box.kind === "text") last.text = (last.text ?? "") + box.text
    else line.push(box)
  }
  for (const child of children) append(child)
  if (clipped) lines.at(-1)!.push({ kind: "unknown", text: "Line limit" })
  return lines.length === 1
    ? { kind: "row", children: lines[0] }
    : { kind: "lines", children: lines.map((items) => ({ kind: "row", children: items })) }
}

// Render only display arguments. Never interpret code, options, template
// functions or hidden InterpretationBox payloads as executable expressions.
export function previewBoxes(source: string, index = 0, cancelled = () => false): Preview {
  let reader = boxReader(source)
  const reasons = new Set<string>()
  const deadline = performance.now() + L.milliseconds
  let nodes = 0
  let dom = 0
  let textLeft = L.text
  let limited = false
  const unknown = (reason: string, limit = false): Box => {
    reasons.add(reason)
    limited ||= limit
    return { kind: "unknown", text: reason }
  }
  const text = (value: string): Box => {
    const clipped = value.length > textLeft
    const shown = value.slice(0, textLeft)
    textLeft -= shown.length
    if (clipped) {
      limited = true
      reasons.add("Text limit")
    }
    return { kind: "text", text: namedCharacters(shown) + (clipped ? "..." : "") }
  }
  const many = (items: BoxNode[], depth: number, merge = false): Box[] => {
    const result: Box[] = []
    for (const item of items) {
      if (nodes >= L.nodes || dom >= L.dom || performance.now() > deadline || cancelled()) {
        result.push(unknown("Display budget exceeded", true))
        break
      }
      const child = visit(item, depth)
      const last = result.at(-1)
      if (merge && last?.kind === "text" && child.kind === "text") last.text += child.text ?? ""
      else result.push(child)
    }
    return result
  }
  const list = (value: BoxNode | undefined, depth: number): Box[] => {
    if (!value) return [unknown("Missing box argument")]
    if (value.head !== "List") return [visit(value, depth)]
    const items = reader.args(value, L.nodes + 1)
    return many(items, depth, true)
  }
  const messageBoxes = (message: string, depth: number): Box => {
    const literal = boxReader(message)
    try {
      message = literal.string(literal.root()) ?? message
    } catch {
      /* Plain message text. */
    }
    const children: Box[] = []
    const pattern = /\\!\\\(\\\*([\s\S]*?)\\\)/g
    let from = 0
    for (const match of message.matchAll(pattern)) {
      if (children.length >= 32 || nodes >= L.nodes || performance.now() > deadline) {
        children.push(unknown("Message display limit", true))
        return flow(children)
      }
      if (match.index > from) children.push(text(message.slice(from, match.index)))
      const previous = reader
      try {
        reader = boxReader(match[1])
        children.push(visit(reader.root(), depth + 1))
      } catch {
        children.push(unknown("Embedded message boxes"))
      } finally {
        reader = previous
      }
      from = match.index + match[0].length
    }
    if (from < message.length) children.push(text(message.slice(from)))
    return flow(children)
  }
  const visit = (value: BoxNode, depth: number): Box => {
    if (++nodes > L.nodes || (dom += 3) > L.dom || depth > L.depth || performance.now() > deadline || cancelled())
      return unknown("Display budget exceeded", true)
    if (value.string) {
      if (value.end - value.start > L.text * 4) return unknown("Large text; open Source", true)
      const result = text(reader.string(value) ?? "")
      return result.text?.includes("\n") ? flow([result]) : result
    }
    if (value.head === "List") return flow(list(value, depth + 1))
    if (wrappers.has(value.head ?? "")) {
      const first = reader.args(value, 1)[0]
      return first ? visit(first, depth + 1) : unknown("Missing box argument")
    }
    if (value.head === "TextData" || value.head === "RowBox") return flow(list(reader.args(value, 1)[0], depth + 1))
    if (value.head === "StyleBox") {
      const [first, ...opts] = reader.args(value, 24)
      if (!first) return unknown("Missing styled content")
      const style: NonNullable<Box["style"]> = {}
      for (const opt of opts) {
        const raw = reader.raw(opt)
        if (/^(?:FontWeight\s*->\s*)?(?:Bold|"Bold")$/.test(raw)) style.bold = true
        if (/^(?:FontSlant\s*->\s*)?(?:Italic|"Italic")$/.test(raw)) style.italic = true
        const size = /^FontSize\s*->\s*(\d+(?:\.\d+)?)$/.exec(raw)
        if (size) style.size = Math.max(8, Math.min(40, Number(size[1])))
      }
      return { kind: "style", style, children: [visit(first, depth + 1)] }
    }
    const layout = layouts[value.head ?? ""]
    if (layout) {
      const items = reader.args(value, layout[1])
      if (items.length !== layout[1]) return unknown(`Malformed ${value.head}`)
      return { kind: layout[0], children: many(items, depth + 1) }
    }
    if (value.head === "GridBox") {
      const rows = reader.args(value, 1)[0]
      if (rows?.head !== "List") return unknown("Malformed GridBox")
      const items = reader.args(rows, 101)
      if (items.length > 100) {
        limited = true
        reasons.add("Grid row limit")
      }
      const children: Box[] = []
      for (const row of items.slice(0, 100)) {
        if (nodes >= L.nodes || dom >= L.dom) {
          children.push(unknown("Grid display limit", true))
          break
        }
        const columns = reader.args(row, 33)
        if (columns.length > 32) {
          limited = true
          reasons.add("Grid column limit")
        }
        dom += columns.length + 1
        children.push({ kind: "row", children: many(columns.slice(0, 32), depth + 1) })
      }
      return { kind: "grid", children }
    }
    if (value.head === "TemplateBox") {
      const [params, tag] = reader.args(value, 2)
      const name = tag && reader.string(tag)
      if (name === "OutputSizeLimit`Skeleton") {
        const count = params && reader.args(params, 1)[0]
        return text(`<<${count ? (reader.string(count) ?? "...") : "..."}>>`)
      }
      if (name === "OutputSizeLimitTemplate" && params) {
        // Only the saved shortenedBoxes value is displayable. The full output
        // may belong to a different kernel session and cannot be recovered.
        const shortened = reader.option(params, "shortenedBoxes")
        if (shortened) {
          limited = true
          reasons.add("Saved shortened output; full result unavailable")
          return visit(shortened, depth + 1)
        }
      }
      if ((name === "MessageTemplate" || name === "MessageTemplate2") && params?.head === "List") {
        const values = reader.args(params, 3)
        const message = values[2] && reader.string(values[2])
        if (message) {
          return messageBoxes(message, depth + 1)
        }
      }
      return unknown(`TemplateBox: ${name ?? "unknown template"}`)
    }
    return unknown(value.head ?? "Unsupported expression")
  }
  let box: Box
  try {
    box = visit(reader.root(), 0)
  } catch (error) {
    box =
      error instanceof Error && error.message === "Notebook nesting is too deep"
        ? unknown("Display depth limit", true)
        : unknown("Malformed boxes")
  }
  // Include generated line/table containers, not just visited source nodes.
  let cost = 0
  const stack = [box]
  while (stack.length) {
    const current = stack.pop()!
    cost++
    if (current.kind === "unknown" && current.text === "Line limit") {
      limited = true
      reasons.add("Line limit")
    }
    if (current.kind === "grid") {
      for (const row of current.children ?? []) {
        const cells = row.children ?? [row]
        cost += 1 + cells.length
        stack.push(...cells)
      }
    } else {
      if (current.kind === "lines") cost += 2 * (current.children?.length ?? 0)
      stack.push(...(current.children ?? []))
    }
    if (cost > L.dom) {
      box = unknown("Display DOM limit", true)
      break
    }
  }
  const result: Preview = {
    index,
    box,
    status: limited ? "limited" : reasons.size ? (box.kind === "unknown" ? "unsupported" : "partial") : "complete",
    reasons: [...reasons],
    nodes,
  }
  if (JSON.stringify(result).length * 3 > L.cellBytes)
    return {
      index,
      box: { kind: "unknown", text: "Display byte limit" },
      status: "limited",
      reasons: ["Display byte limit"],
      nodes: 1,
    }
  return result
}
