import { describe, expect, test } from "bun:test"
import { Marked } from "marked"
import { parseMarkdown as parseNativeMarkdown } from "../../../desktop/src/main/markdown"
import {
  initialMarkdownEager,
  initialMarkdownMathSeen,
  markdownCacheMode,
  markdownFileLink,
  prepareMarkdownSource,
  shouldShowMarkdownCodeTopCopy,
  shouldShowMarkdownMathBottomCopy,
  upgradeStreamingMath,
} from "./markdown"
import {
  healPunctuationEmphasis,
  normalizeAutolink,
  normalizeCodeLanguage,
  prepareMarkdown,
  protectBareAutolinks,
  protectMathExpressions,
  renderMathExpressions,
} from "../context/marked"

describe("markdown fileLink", () => {
  test("parses explicit markdown file links with line and column", () => {
    expect(markdownFileLink("packages/app/src/app.tsx:12:4")).toEqual({
      path: "packages/app/src/app.tsx",
      line: 12,
      col: 4,
    })
  })

  test("parses file paths with line ranges", () => {
    expect(markdownFileLink("packages/app/src/app.tsx:12-18")).toEqual({
      path: "packages/app/src/app.tsx",
      line: 12,
      col: undefined,
      endLine: 18,
    })
  })

  test("parses hash line references", () => {
    expect(markdownFileLink("/tmp/demo/file.ts#L20C3")).toEqual({
      path: "/tmp/demo/file.ts",
      line: 20,
      col: 3,
    })
  })

  test("parses GitHub-style hash line ranges", () => {
    expect(markdownFileLink("Notes/paper.md#L642-L668")).toEqual({
      path: "Notes/paper.md",
      line: 642,
      endLine: 668,
    })
    expect(markdownFileLink("Notes/paper.md#L20C3-L30C7")).toEqual({
      path: "Notes/paper.md",
      line: 20,
      col: 3,
      endLine: 30,
    })
    expect(markdownFileLink("Notes/representation%20theory.md#L12-L24")).toEqual({
      path: "Notes/representation theory.md",
      line: 12,
      endLine: 24,
    })
  })

  test("parses relative and single-file markdown links", () => {
    expect(markdownFileLink("Notes/admissible-characters.md")).toEqual({
      path: "Notes/admissible-characters.md",
      line: undefined,
      col: undefined,
    })
    expect(markdownFileLink("README.md")).toEqual({
      path: "README.md",
      line: undefined,
      col: undefined,
    })
  })

  test("decodes spaces in explicit markdown file links", () => {
    expect(markdownFileLink("Notes/representation%20theory.md#L12C4")).toEqual({
      path: "Notes/representation theory.md",
      line: 12,
      col: 4,
    })
  })

  test("keeps non-file markdown links external", () => {
    expect(markdownFileLink("https://opencode.ai/docs/file-links")).toBeUndefined()
    expect(markdownFileLink("mailto:test@example.com")).toBeUndefined()
    expect(markdownFileLink("#local-heading")).toBeUndefined()
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

  test("does not expose inline math placeholders in indented list items", async () => {
    const markdown = `10. 可取
    $$
    v(z)=\\operatorname{Arg}z+C,\\qquad \\operatorname{Arg}z\\in(-\\pi,\\pi).
    $$

    在穿孔平面中沿单位圆绕原点一周时，$v$ 必须增加 $2\\pi$。`

    const protectedMarkdown = prepareMarkdown(markdown)
    const localHtml = await new Marked().parse(protectedMarkdown)
    const nativeHtml = await parseNativeMarkdown(protectedMarkdown)

    expect(localHtml).not.toContain("<pre>")
    expect(nativeHtml).not.toContain("<pre>")
    expect(localHtml).not.toContain("&lt;span data-opencode-math-style")
    expect(nativeHtml).not.toContain("&lt;span data-opencode-math-style")
  })

  test("keeps markdown links parseable after indented display math in a list item", async () => {
    const markdown = `1. **Schur 态与 VOA 态。** 四维 Schur index 是对受保护态的超迹：
   $$
   \\mathcal I(q)=\\operatorname{Tr} q^{L_0}.
   $$
   态的求迹见[原文式 (1.8)](Papers/Supersymmetric%20Gauge%20Theory/x.md#L104-L112)

2. 下一项。`

    const protectedMarkdown = prepareMarkdown(markdown)
    const localHtml = await new Marked().parse(protectedMarkdown)
    const nativeHtml = await parseNativeMarkdown(protectedMarkdown)

    for (const html of [localHtml, nativeHtml]) {
      expect(html).toContain('<a href="Papers/Supersymmetric%20Gauge%20Theory/x.md#L104-L112"')
      expect(html).not.toContain("[原文式 (1.8)](Papers/")
    }
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

describe("markdown autolinks", () => {
  const glued = "增加这个服务器的维护 https://axonhub-k34h.onrender.com，跟现在的2个render服务器是一样的维护流程。"

  test("ends a bare autolink where CJK prose starts", () => {
    expect(protectBareAutolinks(glued)).toBe(
      "增加这个服务器的维护 <https://axonhub-k34h.onrender.com>，跟现在的2个render服务器是一样的维护流程。",
    )
  })

  test("keeps the trailing prose out of the link for every renderer", async () => {
    const marked = new Marked()
    const prepared = prepareMarkdown(glued)
    const local = await marked.parse(prepared)
    const native = await parseNativeMarkdown(prepared)

    for (const html of [local, native]) {
      expect(html).toContain('<a href="https://axonhub-k34h.onrender.com"')
      expect(html).toContain(">https://axonhub-k34h.onrender.com</a>")
      expect(html).not.toContain("onrender.com，")
      expect(html).toContain("，跟现在的2个render服务器是一样的维护流程。")
    }
  })

  test("stops at CJK punctuation and quotes glued to the URL", () => {
    expect(protectBareAutolinks("见 https://a.com（括号）")).toBe("见 <https://a.com>（括号）")
    expect(protectBareAutolinks('见 “https://a.com”，随后')).toBe('见 “<https://a.com>”，随后')
    expect(protectBareAutolinks("见https://a.com即可")).toBe("见<https://a.com>即可")
  })

  test("leaves plain ASCII URLs and their own trailing punctuation alone", () => {
    const markdown = "see https://example.com/foo?bar=1 for details, then https://example.com."

    expect(protectBareAutolinks(markdown)).toBe(markdown)
  })

  test("keeps parentheses and dots inside a URL", () => {
    const markdown = "see https://en.wikipedia.org/wiki/Foo_(bar)"

    expect(protectBareAutolinks(markdown)).toBe(markdown)
  })

  test("does not rewrite URLs in code spans or fences", () => {
    const markdown = ["`https://a.com，x`", "", "```bash", "curl https://a.com，x", "```"].join("\n")

    expect(protectBareAutolinks(markdown)).toBe(markdown)
  })

  test("does not rewrite existing autolinks or markdown link destinations", () => {
    expect(protectBareAutolinks("<https://a.com，x>")).toBe("<https://a.com，x>")
    expect(protectBareAutolinks("[t](https://a.com，x)")).toBe("[t](https://a.com，x)")
    expect(protectBareAutolinks("[https://a.com，x](y)")).toBe("[https://a.com，x](y)")
    expect(protectBareAutolinks("[见 https://a.com，x](y)")).toBe("[见 https://a.com，x](y)")
  })

  test("still rewrites after a balanced bracket pair in prose", () => {
    expect(protectBareAutolinks("- [ ] 见 https://a.com，x")).toBe("- [ ] 见 <https://a.com>，x")
  })

  test("keeps URLs in protected math untouched", () => {
    const markdown = "公式 $\\text{https://a.com，x}$ 结束"

    expect(protectBareAutolinks(protectMathExpressions(markdown))).toBe(protectMathExpressions(markdown))
  })

  test("trims the rendered href and text of an autolink glued to CJK prose", () => {
    expect(normalizeAutolink("https://a.com，后文", "https://a.com，后文")).toEqual({
      href: "https://a.com",
      text: "https://a.com",
    })
    expect(normalizeAutolink("https://a.com", "https://a.com")).toBeUndefined()
    expect(normalizeAutolink("https://a.com", "label")).toBeUndefined()
    expect(normalizeAutolink("/local/path，后文", "/local/path，后文")).toBeUndefined()
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
