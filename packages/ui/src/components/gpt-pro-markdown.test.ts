import { expect, test } from "bun:test"
import { gptProMarkdown } from "./gpt-pro-markdown"
import { prepareMarkdown, renderMathExpressions } from "../context/marked"
import { Marked } from "marked"

test("restores saved math source once instead of flattened visual/MathML duplicates", async () => {
  const html = String.raw`<h2>定义</h2><p><strong>设</strong> <span class="katex"><span class="katex-mathml"><math><semantics><mi>J</mi><annotation encoding="application/x-tex">J_0</annotation></semantics></math></span><span class="katex-html">J 0</span></span></p><span class="katex-display"><span class="katex"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">Y[u,t]=Y(e^{tL_0}u,e^t-1),\quad \frac{k}{t^2}</annotation></semantics></math><span class="katex-html">broken duplicate</span></span></span>`
  // Bun's raw-template transform escapes Unicode; decode it for this DOM fixture.
  const markdown = gptProMarkdown(
    html.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
    "broken",
  )
  expect(markdown).toContain("## 定义")
  expect(markdown).toContain("**设** $J_0$")
  expect(markdown).not.toContain("broken duplicate")
  const rendered = renderMathExpressions(await new Marked().parse(prepareMarkdown(markdown)), "html")
  expect(rendered).toContain("katex-display")
  expect(rendered).not.toContain("katex-error")
})

test("preserves lists, tables and code and never executes saved HTML", () => {
  expect(gptProMarkdown("<p><span>**Important.**Text</span></p>", "")).toBe("**Important.**Text")
  const result = gptProMarkdown(
    '<ol start="3"><li>One</li><li>Two</li></ol><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre><code class="language-ts">const x = `a`</code></pre><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">unsafe</a>',
    "",
  )
  expect(result).toContain("3. One\n4. Two")
  expect(result).toContain("| A | B |\n| --- | --- |")
  expect(result).toContain("```ts\nconst x = `a`\n```")
  expect(result).not.toContain("alert")
  expect(gptProMarkdown(undefined, "$x^2$")).toBe("$x^2$")
})
