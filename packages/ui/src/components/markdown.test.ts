import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import {
  fileLink,
  findFileLinks,
  initialMarkdownEager,
  initialMarkdownMathSeen,
  markdownCacheMode,
  prepareMarkdownSource,
  shouldShowMarkdownCodeTopCopy,
  shouldShowMarkdownMathBottomCopy,
  upgradeStreamingMath,
} from "./markdown"
import {
  healPunctuationEmphasis,
  normalizeCodeLanguage,
  prepareMarkdown,
  protectMathExpressions,
  renderMathExpressions,
} from "../context/marked"

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
  test("heals incomplete streaming markdown before fast parsing", () => {
    expect(prepareMarkdownSource("hello **world", true)).toBe("hello **world**")
    expect(prepareMarkdownSource("$$\\frac{1}{2}", true)).toBe("$$\\frac{1}{2}")
    expect(prepareMarkdownSource("$$\\frac{1}{2}$$", true)).toBe("$$\\frac{1}{2}$$")
    expect(prepareMarkdownSource("hello **world", false)).toBe("hello **world")
  })

  test("upgrades math during fast streaming renders", () => {
    const source = protectMathExpressions("Result: $x^2$")
    const parsed = `<p>${source}</p>`
    const html = upgradeStreamingMath(parsed, { mode: "fast", math: "full" }, (value) =>
      renderMathExpressions(value, "html"),
    )

    expect(html).toContain("katex")
    expect(upgradeStreamingMath(parsed, { mode: "fast", math: "defer" }, () => "changed")).toBe(parsed)
  })

  test("treats mounted structure stage as math-ready", () => {
    expect(initialMarkdownMathSeen({ stage: "structure" })).toBe(true)
    expect(initialMarkdownMathSeen({ stage: "full" })).toBe(true)
    expect(initialMarkdownMathSeen({ stage: "lite", math: "defer" })).toBe(false)
    expect(initialMarkdownMathSeen({ math: "full" })).toBe(true)
  })

  test("uses the full parser on the first paint when math is explicitly full", () => {
    expect(initialMarkdownEager({ math: "full" })).toBe(true)
    expect(initialMarkdownEager({ math: "defer" })).toBe(false)
    expect(initialMarkdownEager({ stage: "lite", math: "full" })).toBe(false)
    expect(initialMarkdownEager({ stage: "lite", eager: true, math: "full" })).toBe(false)
  })

  test("uses a distinct cache identity after deferred math upgrades", () => {
    const deferred = markdownCacheMode({ highlight: "defer", math: "defer" })
    const full = markdownCacheMode({ highlight: "defer", math: "full" })

    expect(deferred).not.toBe(full)
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

  test("protects inline math that contains comparison less-than", () => {
    const markdown = `- 若 $C \\cdot C<0$：一推开就立刻离开。

$$
\\mathbb P^2
$$`

    const html = protectMathExpressions(markdown)

    expect(html).toContain('data-opencode-math-style="inline"')
    expect(html).toContain('data-opencode-math-tex="C &#92;cdot C&lt;0"')
    expect(html).toContain('data-opencode-math-style="display"')
    expect(html).not.toContain("$C")
    expect(html).not.toContain("$$")
  })

  test("still skips real HTML tags while scanning inline math", () => {
    const markdown = `前置 <span class="x">tag</span> 与 $a+b$ 共存`

    const html = protectMathExpressions(markdown)

    expect(html).toContain('<span class="x">tag</span>')
    expect(html).toContain('data-opencode-math-style="inline"')
    expect(html).toContain('data-opencode-math-tex="a+b"')
    expect(html).not.toContain("$a+b$")
  })

  test("protects inline math that compares two letter variables", () => {
    const markdown = `写 $f_M>0$ 对 $2M<n<60M^2$。更精确：$N_{n,i}$ 的零点随 $i$ 变化，后写 $>0.304$，最小值为 $0.782$。`

    const html = protectMathExpressions(markdown)
    const texes = [...html.matchAll(/data-opencode-math-tex="([^"]*)"/g)].map((match) =>
      match[1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#92;/g, "\\")
        .replace(/&#124;/g, "|"),
    )

    expect(texes).toEqual(["f_M>0", "2M<n<60M^2", "N_{n,i}", "i", ">0.304", "0.782"])
    expect(html).not.toContain("$2M")
    expect(html).not.toContain("$f_M")
    expect(html).not.toContain("$N_")
  })

  test("protects inline math that compares a variable over a number", () => {
    const markdown = `由于 $0<j/24<1$，允许的整数是

$$
m=0,1,\\ldots,M.
$$

因此完整的主 Rademacher 扇区确实形如`

    const html = protectMathExpressions(markdown)
    const texes = [...html.matchAll(/data-opencode-math-tex="([^"]*)"/g)].map((match) =>
      match[1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#92;/g, "\\"),
    )

    expect(texes).toEqual(["0<j/24<1", "m=0,1,\\ldots,M."])
    expect(html).not.toContain("$0<j")
    expect(html).not.toContain("$$")
    expect(html.match(/data-opencode-math-style="display"/g)?.length).toBe(1)
  })

  test("does not swallow later math when a later greater-than exists", () => {
    const markdown = `若 $x<y$ 且 $a>0$，则 $i<n$。`

    const html = protectMathExpressions(markdown)
    const texes = [...html.matchAll(/data-opencode-math-tex="([^"]*)"/g)].map((match) =>
      match[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    )

    expect(texes).toEqual(["x<y", "a>0", "i<n"])
    expect(html).not.toContain("$x<y$")
    expect(html).not.toContain("$a>0$")
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

describe("markdown punctuation emphasis", () => {
  test("closes strong when the marker follows CJK punctuation and a letter", async () => {
    const markdown = "**复核结论先行：**Grok 的总体方向是对的"
    const marked = new Marked()
    const html = await marked.parse(prepareMarkdown(markdown))

    expect(html).toContain("<strong>复核结论先行：</strong>")
    expect(html).toContain("Grok")
    expect(html).not.toContain("**复核结论先行：**")
  })

  test("closes strong and emphasis for ASCII punctuation without a following space", async () => {
    const marked = new Marked()
    const strong = await marked.parse(prepareMarkdown("**hello:**world"))
    const em = await marked.parse(prepareMarkdown("*斜体：*后面"))
    const underscore = await marked.parse(prepareMarkdown("__加粗：__后面"))

    expect(strong).toContain("<strong>hello:</strong>")
    expect(strong).toContain("world")
    expect(em).toContain("<em>斜体：</em>")
    expect(em).toContain("后面")
    expect(underscore).toContain("<strong>加粗：</strong>")
    expect(underscore).toContain("后面")
  })

  test("does not invent emphasis when there is no opener", () => {
    expect(healPunctuationEmphasis("text：**后面")).toBe("text：**后面")
  })

  test("leaves already-valid emphasis and code spans alone", async () => {
    const marked = new Marked()
    const list = await marked.parse(prepareMarkdown("- **P7：确有真正的归纳缺口。**"))
    const code = healPunctuationEmphasis("见 `**复核结论先行：**Grok`")

    expect(list).toContain("<strong>P7：确有真正的归纳缺口。</strong>")
    expect(code).toBe("见 `**复核结论先行：**Grok`")
  })

  test("heals multiple stuck closers on one line", async () => {
    const marked = new Marked()
    const html = await marked.parse(prepareMarkdown("**a：**b **c：**d"))

    expect(html).toContain("<strong>a：</strong>")
    expect(html).toContain("<strong>c：</strong>")
    expect(html).not.toContain("**a：**")
    expect(html).not.toContain("**c：**")
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
