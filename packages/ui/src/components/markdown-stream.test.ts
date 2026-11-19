import { describe, expect, test } from "bun:test"
import { stream } from "./markdown-stream"

describe("markdown stream", () => {
  test("heals incomplete emphasis while streaming", () => {
    expect(stream("hello **world", true)).toEqual([{ raw: "hello **world", src: "hello **world**", mode: "live" }])
    expect(stream("say `code", true)).toEqual([{ raw: "say `code", src: "say `code`", mode: "live" }])
  })

  test("waits for the closing display math delimiter", () => {
    expect(stream("Result:\n\n$$\\frac{1}{2}", true)).toEqual([
      { raw: "Result:\n\n$$\\frac{1}{2}", src: "Result:\n\n$$\\frac{1}{2}", mode: "live" },
    ])
    expect(stream("Result:\n\n$$\\frac{1}{2}$$", true)).toEqual([
      { raw: "Result:\n\n$$\\frac{1}{2}$$", src: "Result:\n\n$$\\frac{1}{2}$$", mode: "live" },
    ])
  })

  test("ignores display math delimiters in code and escapes", () => {
    expect(stream("`$$` and \\$$ plus **bold", true)).toEqual([
      { raw: "`$$` and \\$$ plus **bold", src: "`$$` and \\$$ plus **bold**", mode: "live" },
    ])
    const fenced = stream("```txt\n$$\n```\n\n**bold", true)
    expect(fenced[0]?.src.trimEnd()).toBe("```txt\n$$\n```\n\n**bold**")
    expect(fenced[0]?.src).not.toContain("$$$$")
  })

  test("never truncates completed display math at a less-than comparison", () => {
    const text = "## Outline\n\n$$\nB_0=\\sum_{i<j}R_{ij}F_iF_j\n$$\n\nAFTER_FORMULA\n\n## Proof\n\nFINAL_MARKER"
    for (let length = 1; length <= text.length; length++) {
      const source = text.slice(0, length)
      const result = stream(source, true)
        .map((block) => block.src)
        .join("")
      expect(result).toStartWith(source.trimEnd())
    }
  })

  test("preserves comparison formulas while still completing trailing emphasis", () => {
    for (const formula of ["$$\\sum_{i<j}a_{ij}$$", "\\[x<y\\]", "$i<j$"]) {
      const source = `${formula}\n\nAFTER_FORMULA **bold`
      expect(stream(source, true)[0]?.src).toBe(`${source}**`)
    }
  })

  test("keeps incomplete links non-clickable until they finish", () => {
    expect(stream("see [docs](https://example.com/gu", true)).toEqual([
      { raw: "see [docs](https://example.com/gu", src: "see docs", mode: "live" },
    ])
  })

  test("splits an unfinished trailing code fence from stable content", () => {
    expect(stream("before\n\n```ts\nconst x = 1", true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "live" },
      { raw: "```ts\nconst x = 1", src: "```ts\nconst x = 1", mode: "live" },
    ])
  })

  test("keeps reference-style markdown as one block", () => {
    expect(stream("[docs][1]\n\n[1]: https://example.com", true)).toEqual([
      {
        raw: "[docs][1]\n\n[1]: https://example.com",
        src: "[docs][1]\n\n[1]: https://example.com",
        mode: "live",
      },
    ])
  })
})

import { renderStreaming, splitStreaming } from "./markdown-stream"

describe("splitStreaming", () => {
  test("splits at blank lines only", () => {
    expect(splitStreaming("a\n\nb\n\n\nc").chunks).toEqual(["a\n\n", "b\n\n", "c"])
    expect(splitStreaming("a\nb").chunks).toEqual(["a\nb"])
  })

  test("never splits inside a fenced code block", () => {
    const text = "before\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nafter"
    const { chunks, live } = splitStreaming(text)
    expect(chunks).toEqual(["before\n\n", "```ts\nconst a = 1\n\nconst b = 2\n```\n\n", "after"])
    expect(live).toBe("text")
  })

  test("reports an unclosed fence and math tail", () => {
    expect(splitStreaming("```ts\nconst x = 1").live).toBe("fence")
    expect(splitStreaming("$$\nx<y").live).toBe("math")
    expect(splitStreaming("`$$` still code").live).toBe("text")
  })
})

describe("renderStreaming", () => {
  const render = (src: string) => `<p>${src.trim()}</p>`

  test("joins per-chunk html and heals the tail", async () => {
    const out = await renderStreaming("one\n\ntwo **bold", undefined, render)
    expect(out.html).toBe("<p>one</p><p>two **bold**</p>")
    expect(out.state.inputs).toHaveLength(2)
  })

  test("re-renders only the divergent tail", async () => {
    let calls = 0
    const counted = (src: string) => {
      calls++
      return render(src)
    }
    const first = await renderStreaming("one\n\ntwo", undefined, counted)
    expect(calls).toBe(2)
    const second = await renderStreaming("one\n\ntwo and more", first.state, counted)
    expect(calls).toBe(3)
    expect(second.state.inputs[0]).toBe(first.state.inputs[0])
    const third = await renderStreaming("one\n\ntwo and more\n\nthree", second.state, counted)
    expect(calls).toBe(4)
    expect(third.state.htmls[0]).toBe(second.state.htmls[0])
  })

  test("keeps a live code fence raw instead of healing it", async () => {
    const seen: string[] = []
    await renderStreaming("```ts\nconst x = 1", undefined, (src) => {
      seen.push(src)
      return ""
    })
    expect(seen[0]).toBe("```ts\nconst x = 1")
  })

  test("prepends link definitions to every chunk", async () => {
    const seen: string[] = []
    const out = await renderStreaming("[docs][1]\n\n[1]: https://x.test\n\nmore [docs][1]", undefined, (src) => {
      seen.push(src)
      return `<b>${src.includes("[1]:") ? "has-def" : "no-def"}</b>`
    })
    // The pure-def chunk renders to nothing without calling render.
    expect(seen).toHaveLength(2)
    expect(seen.every((src) => src.includes("[1]:"))).toBe(true)
    expect(out.html).toBe("<b>has-def</b><b>has-def</b>")
  })

  test("ignores def-shaped lines inside fenced code", async () => {
    const seen: string[] = []
    await renderStreaming("```md\n[a]: https://x.test\n```\n\n[a]", undefined, (src) => {
      seen.push(src)
      return src
    })
    // The def line lives inside a fence so it must not leak into the next
    // chunk's prefix; only the real fence chunk and the paragraph render.
    expect(seen).toHaveLength(2)
    expect(seen[1]).not.toContain("[a]:")
  })
})
