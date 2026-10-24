// Saved text is browser innerText, not Markdown: KaTeX's visual and MathML
// trees get flattened together. Recover semantic source from the saved DOM.
export function gptProMarkdown(html: string | undefined, fallback: string | undefined): string {
  if (!html || typeof DOMParser === "undefined") return fallback ?? ""
  const root = new DOMParser().parseFromString(html, "text/html").body
  let formulas = 0
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/([\\`_\[\]<>])/g, "\\$1")
    if (node.nodeType !== 1) return ""
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (["script", "style", "iframe", "object", "embed", "button", "svg", "form"].includes(tag)) return ""
    if (el.matches(".katex-display, .katex, math")) {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent
      if (tex) {
        formulas++
        return el.matches(".katex-display, math[display=block]") ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`
      }
    }
    if (tag === "pre") {
      const code = el.querySelector("code") ?? el
      const language = code.className.match(/language-([\w+-]+)/)?.[1] ?? ""
      const text = code.textContent ?? ""
      const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)))
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`
    }
    const content = Array.from(el.childNodes, walk).join("")
    if (tag === "br") return "  \n"
    if (tag === "strong" || tag === "b") return `**${content}**`
    if (tag === "em" || tag === "i") return `*${content}*`
    if (tag === "code") return `\`\` ${el.textContent ?? ""} \`\``
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${content}\n\n`
    if (tag === "a") {
      const href = el.getAttribute("href") ?? ""
      return /^https?:\/\//i.test(href) ? `[${content}](<${href.replace(/[<>\n\r]/g, "")}>)` : content
    }
    if (tag === "blockquote")
      return `\n\n${content
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`
    if (tag === "li") {
      const index = Array.from(el.parentElement?.children ?? []).indexOf(el)
      const marker =
        el.parentElement?.tagName === "OL" ? `${Number(el.parentElement.getAttribute("start") ?? 1) + index}. ` : "- "
      return `${marker}${content.trim().replace(/\n/g, "\n    ")}\n`
    }
    if (tag === "th" || tag === "td") return ` ${content.trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")} |`
    if (tag === "tr") {
      const header = el.querySelector("th")
      return `|${content}\n${header ? `|${Array.from(el.children, () => " --- |").join("")}\n` : ""}`
    }
    if (["p", "div", "ul", "ol", "table"].includes(tag)) return `\n\n${content}\n\n`
    if (tag === "hr") return "\n\n---\n\n"
    return content
  }
  const markdown = Array.from(root.childNodes, walk).join("").trim()
  console.debug(
    `[gpt-pro-result] restored markdown html=${html.length} markdown=${markdown.length} formulas=${formulas}`,
  )
  return markdown || fallback || ""
}
