import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import {
  fileLink,
  findFileLinks,
  initialMarkdownMathSeen,
  shouldShowMarkdownCodeTopCopy,
  shouldShowMarkdownMathBottomCopy,
} from "./markdown"
import { normalizeCodeLanguage, protectMathExpressions, renderMathExpressions } from "../context/marked"

describe("markdown fileLink", () => {
  test("parses relative file paths", () => {
    expect(fileLink(".trellis/tasks/foo/scripts/run.py")).toEqual({
      path: ".trellis/tasks/foo/scripts/run.py",
      line: undefined,
      col: undefined,
    })
  })

  test("parses file paths with line and column", () => {
    expect(fileLink("packages/app/src/app.tsx:12:4")).toEqual({
      path: "packages/app/src/app.tsx",
      line: 12,
      col: 4,
    })
  })

  test("parses file paths with line ranges", () => {
    expect(fileLink("packages/app/src/app.tsx:12-18")).toEqual({
      path: "packages/app/src/app.tsx",
      line: 12,
      col: undefined,
    })
  })

  test("parses hash line references", () => {
    expect(fileLink("/tmp/demo/file.ts#L20C3")).toEqual({
      path: "/tmp/demo/file.ts",
      line: 20,
      col: 3,
    })
  })

  test("parses @ file mentions with spaces and non-ascii path segments", () => {
    expect(fileLink("@广义相对论讲义/Schwarzchild Balck Hole/assets/rain-null-geodesics.html")).toEqual({
      path: "广义相对论讲义/Schwarzchild Balck Hole/assets/rain-null-geodesics.html",
      line: undefined,
      col: undefined,
    })
  })

  test("finds full @ file mention instead of suffix after a path space", () => {
    const text = "参考 @广义相对论讲义/Schwarzchild Balck Hole/assets/rain-null-geodesics.html 生成"
    const raw = "@广义相对论讲义/Schwarzchild Balck Hole/assets/rain-null-geodesics.html"
    const start = text.indexOf(raw)

    expect(findFileLinks(text)).toEqual([
      {
        raw,
        start,
        end: start + raw.length,
        link: {
          path: "广义相对论讲义/Schwarzchild Balck Hole/assets/rain-null-geodesics.html",
          line: undefined,
          col: undefined,
        },
      },
    ])
  })

  test("ignores urls", () => {
    expect(fileLink("https://opencode.ai/docs/file.ts")).toBeUndefined()
  })

  test("ignores fractions", () => {
    expect(fileLink("9/8")).toBeUndefined()
    expect(fileLink("9/4")).toBeUndefined()
  })

  test("ignores plain slash-separated prose", () => {
    expect(fileLink("mode/Zhu")).toBeUndefined()
  })

  test("ignores inline code commands containing file paths", () => {
    expect(fileLink("pytest tests/test_backend.py tests/test_operator_spaces.py -q")).toBeUndefined()
  })
})

describe("markdown math", () => {
  test("treats mounted structure stage as math-ready", () => {
    expect(initialMarkdownMathSeen({ stage: "structure" })).toBe(true)
    expect(initialMarkdownMathSeen({ stage: "full" })).toBe(true)
    expect(initialMarkdownMathSeen({ stage: "lite", math: "defer" })).toBe(false)
    expect(initialMarkdownMathSeen({ math: "full" })).toBe(true)
  })

  test("adds bottom copy affordance only for tall display math", () => {
    expect(shouldShowMarkdownMathBottomCopy(159)).toBe(false)
    expect(shouldShowMarkdownMathBottomCopy(160)).toBe(true)
  })

  test("protects display math from markdown block parsing", () => {
    const markdown = `好的，本题已完成。核心结果是：

$$
n_k(a)
=
\\sum_{r=0}^{k}
\\frac{B_r}{r!}
E_{k+1-r}\\left[\\begin{matrix}-1\\\\ ab\\end{matrix}\\right]
+
p(a),
\\qquad
p(aq)=p(a),
$$`

    const html = protectMathExpressions(markdown)

    expect(html).toContain('data-opencode-math-style="display"')
    expect(html).toContain("n_k(a)&#10;=&#10;&#92;sum")
    expect(html).toContain("&#92;begin{matrix}-1&#92;&#92; ab&#92;end{matrix}")
    expect(html).not.toContain("$$")
  })

  test("renders protected display math with relation and matrix rows", () => {
    const protectedHtml =
      '<p>核心结果是：</p><div data-opencode-math-style="display">n_k(a)\n=\nE_k\\left[\\begin{matrix}-1\\\\ ab\\end{matrix}\\right]</div>'

    const html = renderMathExpressions(protectedHtml, "html")

    expect(html).toContain('data-opencode-math-tex="n_k(a)&#10;=&#10;E_k&#92;left')
    expect(html).toContain("katex-display")
    expect(html).toContain("mrel")
    expect(html).toContain("mtable")
  })

  test("protects inline math commands before markdown parsing", () => {
    const html = protectMathExpressions("约定 $E_0\\!\\left[\\substack{-1\\\\ z}\\right]=-1$ 下满足")

    expect(html).toContain('data-opencode-math-style="inline"')
    expect(html).toContain('data-opencode-math-tex="E_0&#92;!&#92;left')
    expect(html).toContain("&#92;substack{-1&#92;&#92; z}")
    expect(html).not.toContain("$E_0")
  })

  test("keeps inline math escapes through markdown parsing", async () => {
    const marked = new Marked()
    const protectedMarkdown = protectMathExpressions("约定 $E_0\\!\\left[\\substack{-1\\\\ z}\\right]=-1$ 下满足")
    const parsed = await marked.parse(protectedMarkdown)
    const html = renderMathExpressions(parsed, "html")

    expect(parsed).toContain("data-opencode-math-tex")
    expect(parsed).toContain("E_0&#92;!&#92;left")
    expect(html).toContain("katex")
    expect(html).toContain("mspace")
    expect(html).toContain("vlist")
    expect(html).not.toContain("E_0!")
    expect(html).not.toContain("\\substack")
  })

  test("renders protected inline spacing and substack commands", () => {
    const protectedHtml =
      '<p>约定 <span data-math-style="inline">E_0\\!\\left[\\substack{-1\\\\ z}\\right]=-1</span> 下满足</p>'

    const html = renderMathExpressions(protectedHtml, "html")

    expect(html).toContain("katex")
    expect(html).not.toContain("data-opencode-math-tex")
    expect(html).toContain("mspace")
    expect(html).toContain("vlist")
    expect(html).not.toContain("E_0!")
    expect(html).not.toContain("\\substack")
  })

  test("renders common latex package macros", () => {
    const html = renderMathExpressions('<p><span data-math-style="inline">\\slashed{p}+\\ket{0}</span></p>', "html")

    expect(html).toContain("katex")
    expect(html).not.toContain("katex-error")
    expect(html).not.toContain("\\slashed")
    expect(html).not.toContain("\\ket")
  })

  test("does not protect inline math inside code", () => {
    const html = protectMathExpressions("`$E_0[\\substack{-1\\\\ z}]=-1$`")

    expect(html).toBe("`$E_0[\\substack{-1\\\\ z}]=-1$`")
  })

  test("escapes pipes in protected math so GFM tables keep cell boundaries", async () => {
    const markdown = `| 对象 | 性质 |
|------|------|
| 阶与次数 | $\\|G\\| = \\prod_{i=1}^n d_i$ |
| 自由性 | $\\mathbb{C}[V]$ 作为 $\\mathbb{C}[V]^G$-模是自由的，秩为 $\\|G\\|$ |
| 集合 | 次数 $\\{d_i\\}$ 唯一 |`

    const protectedMarkdown = protectMathExpressions(markdown)

    expect(protectedMarkdown).toContain("&#124;")
    expect(protectedMarkdown).toContain('data-opencode-math-tex="&#92;&#124;G&#92;&#124; = &#92;prod_{i=1}^n d_i"')
    expect(protectedMarkdown).not.toMatch(/data-opencode-math-tex="[^"]*\|/)

    const marked = new Marked()
    const parsed = await marked.parse(protectedMarkdown)
    const html = renderMathExpressions(parsed, "html")

    expect(parsed).toContain("<table>")
    expect(parsed).toContain("<td>")
    expect(parsed).not.toContain("&lt;span data-opencode-math-style")
    expect(parsed.match(/<tr>/g)?.length).toBe(4)
    expect(html).toContain("katex")
    expect(html).not.toContain("katex-error")
  })
})

describe("markdown code copy affordance", () => {
  test("adds top copy affordance only for code blocks longer than 15 lines", () => {
    const fifteenLines = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n")
    const sixteenLines = Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join("\n")

    expect(shouldShowMarkdownCodeTopCopy(fifteenLines)).toBe(false)
    expect(shouldShowMarkdownCodeTopCopy(`${fifteenLines}\n`)).toBe(false)
    expect(shouldShowMarkdownCodeTopCopy(sixteenLines)).toBe(true)
  })
})

describe("markdown code language", () => {
  test("normalizes Mathematica aliases to Wolfram language", () => {
    expect(normalizeCodeLanguage("mathematica")).toBe("wolfram")
    expect(normalizeCodeLanguage("Mathematica")).toBe("wolfram")
    expect(normalizeCodeLanguage("mma")).toBe("wolfram")
    expect(normalizeCodeLanguage("wls")).toBe("wolfram")
    expect(normalizeCodeLanguage("wl")).toBe("wolfram")
  })

  test("falls back unsupported code languages to text", () => {
    expect(normalizeCodeLanguage("not-a-language")).toBe("text")
  })
})
