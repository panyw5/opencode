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

function openDisplayMath(text: string) {
  let math = false
  let codeSpan = 0
  let fenceChar = ""
  let fenceSize = 0

  for (const line of text.split(/\r?\n/)) {
    const fence = codeSpan === 0 && !math ? line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1] : undefined
    if (fence) {
      if (!fenceChar) {
        fenceChar = fence[0]!
        fenceSize = fence.length
      } else if (fence[0] === fenceChar && fence.length >= fenceSize) {
        fenceChar = ""
        fenceSize = 0
      }
      continue
    }
    if (fenceChar) continue

    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") {
        i++
        continue
      }
      if (line[i] === "`") {
        let size = 1
        while (line[i + size] === "`") size++
        if (codeSpan === 0) codeSpan = size
        else if (codeSpan === size) codeSpan = 0
        i += size - 1
        continue
      }
      if (codeSpan !== 0 || line[i] !== "$" || line[i + 1] !== "$") continue
      math = !math
      i++
    }
  }

  return math
}

function heal(text: string) {
  if (openDisplayMath(text)) return text
  const healed = remend(text, { linkMode: "text-only" })
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
