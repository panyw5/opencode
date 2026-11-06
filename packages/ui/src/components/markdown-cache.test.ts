import { describe, expect, test } from "bun:test"
import { MarkdownHtmlCache, markdownRendererScope, renderMarkdownWithFallback } from "./markdown-cache"

class FaultCache extends MarkdownHtmlCache {
  damage(key: string) {
    const entry = this.entries.get(key)!
    this.entries.set(key, { ...entry, html: "corrupt output" })
  }
}

describe("Markdown cache integrity", () => {
  test("matching checksums cannot hide a different source or let an older source overwrite it", () => {
    const cache = new MarkdownHtmlCache()
    const old = cache.begin("part", "collision", "old source")
    const current = cache.begin("part", "collision", "new source")
    expect(cache.set("part", "collision", "new HTML", { ticket: current, source: "new source" })).toBe(true)
    expect(cache.set("part", "collision", "wrong HTML", { ticket: current, source: "other source" })).toBe(false)
    expect(cache.set("part", "collision", "old HTML", { ticket: old, source: "old source" })).toBe(false)
    expect(cache.get("part", "collision", "new source")).toBe("new HTML")
    expect(cache.get("part", "collision", "other source")).toBeUndefined()
  })
  test("a late old-source render cannot overwrite a newer successful render", () => {
    const cache = new MarkdownHtmlCache()
    const old = cache.begin("part", "old")
    const current = cache.begin("part", "new")
    expect(cache.set("part", "new", "new HTML", { ticket: current })).toBe(true)
    expect(cache.set("part", "old", "old HTML", { ticket: old })).toBe(false)
    expect(cache.get("part", "new")).toBe("new HTML")
  })

  test("a successful same-source render remains reusable when a duplicate request failed", () => {
    const cache = new MarkdownHtmlCache()
    const first = cache.begin("part", "same")
    const second = cache.begin("part", "same")
    expect(cache.set("part", "same", "fallback", { ticket: second, fallback: true })).toBe(false)
    expect(cache.set("part", "same", "correct", { ticket: first })).toBe(true)
    expect(cache.get("part", "same")).toBe("correct")
  })
  test("renderer changes have distinct cache scopes while ordinary remounts reuse the same scope", () => {
    const renderer = {}
    expect(markdownRendererScope(renderer)).toBe(markdownRendererScope(renderer))
    expect(markdownRendererScope(renderer)).not.toBe(markdownRendererScope({}))
  })
  test("valid HTML is reusable and corruption is discarded and repairable", () => {
    const cache = new FaultCache()
    cache.set("part", "source", "<p>correct</p>")
    expect(cache.get("part", "source")).toBe("<p>correct</p>")
    cache.damage("part")
    expect(cache.get("part", "source")).toBeUndefined()
    expect(cache.size).toBe(0)
    cache.set("part", "source", "<p>rebuilt</p>")
    expect(cache.get("part", "source")).toBe("<p>rebuilt</p>")
  })

  test("changed source and incomplete or failed renders cannot be cache hits", () => {
    const cache = new MarkdownHtmlCache()
    cache.set("part", "old", "old HTML")
    expect(cache.get("part", "new")).toBeUndefined()
    expect(cache.set("part", "new", "partial", { streaming: true })).toBe(false)
    expect(cache.set("part", "new", "fallback", { fallback: true })).toBe(false)
    expect(cache.get("part", "new")).toBeUndefined()
  })

  test("legitimately empty HTML is a valid result and cache size is bounded", () => {
    const cache = new MarkdownHtmlCache(2)
    cache.set("comment", "source", "")
    expect(cache.get("comment", "source")).toBe("")
    cache.set("one", "source", "one")
    cache.set("two", "source", "two")
    expect(cache.size).toBe(2)
    expect(cache.get("comment", "source")).toBeUndefined()
  })
})

describe("Markdown rendering recovery", () => {
  test("rejected parsing uses a non-cacheable fallback, then a successful retry repairs it", async () => {
    const failed = await renderMarkdownWithFallback({
      render: () => {
        throw Error("temporary failure")
      },
      fallback: () => "fallback",
    })
    expect(failed).toEqual({ html: "fallback", fallback: true })
    const recovered = await renderMarkdownWithFallback({ render: () => "correct", fallback: () => "fallback" })
    expect(recovered).toEqual({ html: "correct", fallback: false })
  })

  test("timeout covers the actual asynchronous parse and ignores late completion", async () => {
    let complete!: (html: string) => void
    const parsing = new Promise<string>((resolve) => (complete = resolve))
    const result = await renderMarkdownWithFallback({
      render: () => parsing,
      fallback: async () => "fallback",
      timeout: 5,
    })
    expect(result).toEqual({ html: "fallback", fallback: true })
    complete("too late")
    await Promise.resolve()
    expect(result).toEqual({ html: "fallback", fallback: true })
  })
})
