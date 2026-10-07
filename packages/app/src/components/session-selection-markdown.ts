import TurndownService from "turndown"

function mathMarkdown(node: Element): string | undefined {
  const source =
    node.getAttribute("data-opencode-math-tex") ??
    node.querySelector('annotation[encoding="application/x-tex"]')?.textContent
  if (!source) return
  const display =
    node.getAttribute("data-opencode-math-style") === "display" ||
    node.getAttribute("data-component") === "markdown-math" ||
    node.classList.contains("katex-display") ||
    !!node.parentElement?.closest(".katex-display")
  return display ? `\n\n$$\n${source}\n$$\n\n` : `$${source}$`
}

const service = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  blankReplacement: (_content, node) =>
    mathMarkdown(node as Element) ?? ((node as { isBlock?: boolean }).isBlock ? "\n\n" : ""),
})
service.remove((node) => ["BUTTON", "SCRIPT", "STYLE", "SVG"].includes(node.nodeName.toUpperCase()))
service.addRule("math", {
  filter: (node) =>
    node.hasAttribute("data-opencode-math-tex") ||
    node.classList.contains("katex") ||
    node.classList.contains("katex-display"),
  replacement: (content, node) => mathMarkdown(node as Element) ?? content,
})
service.addRule("table", {
  filter: "table",
  replacement: (_content, node) => {
    const rows = Array.from(node.querySelectorAll("tr")).map((row) =>
      Array.from(row.querySelectorAll("th, td")).map((cell) =>
        service.turndown(cell.innerHTML).replace(/\|/g, "\\|").replace(/\n+/g, "<br>"),
      ),
    )
    if (!rows.length) return ""
    const width = Math.max(...rows.map((row) => row.length))
    const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`
    return `\n\n${[line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`
  },
})

export function selectionMarkdown(range: Range): string {
  const selection = range.cloneRange()
  const math = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement
    return element?.closest(".katex-display") ?? element?.closest(".katex")
  }
  const startMath = math(selection.startContainer)
  const endMath = math(selection.endContainer)
  // Glyph ranges do not include the source metadata or hidden sibling nodes.
  // A rendered formula is atomic: include the entire formula at either endpoint.
  if (startMath) selection.setStartBefore(startMath)
  if (endMath) selection.setEndAfter(endMath)
  console.debug(`[session-selection] markdown clone startMath=${!!startMath} endMath=${!!endMath}`)
  const container = document.createElement("div")
  let fragment: Node = selection.cloneContents()
  // cloneContents omits shared ancestors, including inline formatting and code fences.
  let ancestor = selection.commonAncestorContainer
  if (ancestor.nodeType === Node.TEXT_NODE) ancestor = ancestor.parentNode!
  while (ancestor instanceof Element && !ancestor.matches('[data-component="markdown"], [data-timeline-row]')) {
    const wrapper = ancestor.cloneNode(false)
    wrapper.appendChild(fragment)
    fragment = wrapper
    ancestor = ancestor.parentNode!
  }
  container.appendChild(fragment)
  container
    .querySelectorAll('button, [aria-hidden="true"]:not(.katex-html), [data-slot="user-message-meta"]')
    .forEach((node) => node.remove())
  const markdown = service.turndown(container.innerHTML).trim()
  console.debug(
    `[session-selection] markdown converted formulas=${container.querySelectorAll("[data-opencode-math-tex], .katex").length} length=${markdown.length}`,
  )
  return markdown
}
