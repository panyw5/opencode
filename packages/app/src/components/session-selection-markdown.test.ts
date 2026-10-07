import { describe, expect, test } from "bun:test"
import { selectionMarkdown } from "./session-selection-markdown"
import { renderMathExpressions } from "@opencode-ai/ui/context/marked"

function select(html: string, selector?: string, start?: number, end?: number) {
  const root = document.createElement("div")
  root.dataset.component = "markdown"
  root.innerHTML = html
  const range = document.createRange()
  const node = selector ? root.querySelector(selector)! : root
  if (start !== undefined) {
    range.setStart(node.firstChild!, start)
    range.setEnd(node.firstChild!, end!)
  } else range.selectNodeContents(node)
  return selectionMarkdown(range)
}

describe("session selection Markdown", () => {
  test("preserves heading, list, links and emphasis without copy controls", () => {
    expect(
      select(
        '<h2>Title</h2><p><strong>Bold</strong> and <a href="https://example.com">link</a></p><ul><li>One</li><li>Two</li></ul><button>Copy</button>',
      ),
    ).toBe("## Title\n\n**Bold** and [link](https://example.com)\n\n-   One\n-   Two")
  })
  test("preserves formatting of a partial inline selection", () => {
    expect(select("<p>before <strong>selected words</strong> after</p>", "strong", 0, 8)).toBe("**selected**")
  })
  test("preserves code language for a partial code selection", () => {
    expect(select('<pre><code class="language-ts">const x = 1\nconst y = 2</code></pre>', "code", 0, 11)).toBe(
      "```ts\nconst x = 1\n```",
    )
  })
  test("copies only selected paragraphs", () => {
    expect(select("<p>before</p><p>chosen</p><p>after</p>", "p:nth-child(2)")).toBe("chosen")
  })
  test("preserves table syntax", () => {
    expect(
      select(
        "<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table>",
      ),
    ).toBe("| Name | Value |\n| --- | --- |\n| A | 1 |")
  })
  test("restores math source rather than duplicated rendered glyphs", () => {
    expect(
      select(
        '<span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2</span></span>',
      ),
    ).toBe("$x^2$")
  })
  test("preserves display math", () => {
    expect(
      select(
        '<span class="katex-display"><span class="katex"><annotation encoding="application/x-tex">x^2</annotation></span></span>',
      ),
    ).toBe("$$\nx^2\n$$")
  })
  test("restores inline LaTeX in the actual desktop HTML-only renderer", () => {
    const html = renderMathExpressions('<p>Before <span data-math-style="inline">\\frac{a}{b}</span> after</p>', "html")
    expect(html).not.toContain("annotation")
    expect(select(html)).toBe("Before $\\frac{a}{b}$ after")
  })
  test("restores display LaTeX without MathML annotations", () => {
    const html = renderMathExpressions('<span data-math-style="display">\\int_0^1 x^2\\,dx</span>', "html")
    expect(select(html)).toBe("$$\n\\int_0^1 x^2\\,dx\n$$")
  })
  test("selecting only a rendered glyph copies the complete inline formula", () => {
    const html = renderMathExpressions('<p>Before <span data-math-style="inline">\\frac{a}{b}</span> after</p>', "html")
    expect(select(html, ".mord.mathnormal", 0, 1)).toBe("$\\frac{a}{b}$")
  })
  test("selecting only a rendered glyph copies the complete display formula", () => {
    const html = renderMathExpressions('<span data-math-style="display">a^2+b^2</span>', "html")
    expect(select(html, ".mord.mathnormal", 0, 1)).toBe("$$\na^2+b^2\n$$")
  })
  test("keeps display delimiters inside the desktop formula copy wrapper", () => {
    const html = renderMathExpressions('<span data-math-style="display">a^2+b^2</span>', "html")
    const wrapped = `<div data-component="markdown-math" data-opencode-math-tex="a^2+b^2"><div data-slot="markdown-math-viewport">${html}</div><button>Copy</button></div>`
    expect(select(wrapped)).toBe("$$\na^2+b^2\n$$")
    expect(select(wrapped, ".mord.mathnormal", 0, 1)).toBe("$$\na^2+b^2\n$$")
  })
  test("preserves the source of invisible math", () => {
    expect(
      select(
        '<span class="katex" data-opencode-math-style="inline" data-opencode-math-tex="\\quad"><span class="katex-html" aria-hidden="true"></span></span>',
      ),
    ).toBe("$\\quad$")
  })
  test("keeps original math attributes containing escaped HTML and replacement tokens", () => {
    const source = "a<b \\text{\\$&}"
    const html = renderMathExpressions('<span data-math-style="inline">a&lt;b \\text{\\$&amp;}</span>', "html")
    expect(select(html)).toBe(`$${source}$`)
  })
})
