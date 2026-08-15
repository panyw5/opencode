export type IndentEdit = {
  text: string
  start: number
  end: number
}

const INDENT = "  "

/** Handle Tab / Shift+Tab on a controlled textarea; returns true when handled. */
export function handleTextareaIndent(
  event: KeyboardEvent & { currentTarget: HTMLTextAreaElement },
  text: string,
  onChange: (next: IndentEdit) => void,
): boolean {
  if (event.key !== "Tab") return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.isComposing || event.keyCode === 229) return false

  const target = event.currentTarget
  const next = indent({
    text,
    start: target.selectionStart ?? 0,
    end: target.selectionEnd ?? 0,
    shiftKey: event.shiftKey,
  })
  event.preventDefault()
  if (!next) return true
  onChange(next)
  requestAnimationFrame(() => {
    target.setSelectionRange(next.start, next.end)
  })
  return true
}

function lineStart(text: string, pos: number) {
  const idx = text.lastIndexOf("\n", Math.max(0, pos - 1))
  return idx === -1 ? 0 : idx + 1
}

function lineEnd(text: string, pos: number) {
  const idx = text.indexOf("\n", pos)
  return idx === -1 ? text.length : idx
}

/** Tab / Shift+Tab indent-outdent for markdown source editors. */
export function indent(input: {
  text: string
  start: number
  end: number
  shiftKey: boolean
}): IndentEdit | null {
  const { text, start, end, shiftKey } = input

  // Caret only: insert or remove indent at the current line start relative to caret.
  if (start === end) {
    if (!shiftKey) {
      return {
        text: text.slice(0, start) + INDENT + text.slice(end),
        start: start + INDENT.length,
        end: start + INDENT.length,
      }
    }

    const from = lineStart(text, start)
    const before = text.slice(from, start)
    if (before.startsWith(INDENT)) {
      return {
        text: text.slice(0, from) + before.slice(INDENT.length) + text.slice(start),
        start: start - INDENT.length,
        end: start - INDENT.length,
      }
    }
    if (before.startsWith("\t")) {
      return {
        text: text.slice(0, from) + before.slice(1) + text.slice(start),
        start: start - 1,
        end: start - 1,
      }
    }
    if (before.startsWith(" ")) {
      return {
        text: text.slice(0, from) + before.slice(1) + text.slice(start),
        start: start - 1,
        end: start - 1,
      }
    }
    return null
  }

  // Multi-line (or partial-line) selection: indent/outdent each covered line.
  const from = lineStart(text, start)
  const to = lineEnd(text, end)
  const block = text.slice(from, to)
  const lines = block.split("\n")

  if (!shiftKey) {
    const next = lines.map((line) => INDENT + line).join("\n")
    const delta = INDENT.length * lines.length
    return {
      text: text.slice(0, from) + next + text.slice(to),
      start: start + INDENT.length,
      end: end + delta,
    }
  }

  let removedBeforeStart = 0
  let removedTotal = 0
  const nextLines = lines.map((line, index) => {
    let drop = 0
    if (line.startsWith(INDENT)) drop = INDENT.length
    else if (line.startsWith("\t")) drop = 1
    else if (line.startsWith(" ")) drop = 1
    if (drop === 0) return line

    const lineFrom = lines.slice(0, index).reduce((sum, item) => sum + item.length + 1, 0)
    const absolute = from + lineFrom
    if (absolute + drop <= start) removedBeforeStart += drop
    else if (absolute < start) removedBeforeStart += start - absolute
    removedTotal += drop
    return line.slice(drop)
  })

  if (removedTotal === 0) return null

  return {
    text: text.slice(0, from) + nextLines.join("\n") + text.slice(to),
    start: Math.max(from, start - removedBeforeStart),
    end: Math.max(from, end - removedTotal),
  }
}
