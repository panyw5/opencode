import { describe, expect, test } from "bun:test"
import { decorateMarkdown, prepareMarkdownDom, reconcileMarkdownDom } from "@opencode-ai/ui/markdown"

const labels = { copy: "Copy", copied: "Copied" }

describe("markdown decoration", () => {
  test("keeps canonical links and persistent enhancements stable while the live tail grows", () => {
    const current = document.createElement("div")
    current.innerHTML =
      '<p>所以 <a href="run-wz3-tests.wls" class="external-link" target="_blank">run-wz3-tests.wls</a> 是</p><pre><code>example</code></pre>'
    decorateMarkdown(current, labels)
    const originalLink = current.querySelector<HTMLAnchorElement>("a[data-file-link]")
    const originalCopy = current.querySelector<HTMLButtonElement>('[data-slot="markdown-copy-button"]')

    const incoming = document.createElement("div")
    incoming.innerHTML =
      '<p>所以 <a href="run-wz3-tests.wls" class="external-link" target="_blank">run-wz3-tests.wls</a> 是 V0A-tests.wls 中部分实验的可重复、可判定版本。</p><pre><code>example</code></pre>'

    prepareMarkdownDom(incoming)
    prepareMarkdownDom(incoming)
    reconcileMarkdownDom(current, incoming)

    const link = current.querySelector<HTMLAnchorElement>("a[data-file-link]")
    const copy = current.querySelector<HTMLButtonElement>('[data-slot="markdown-copy-button"]')
    expect(link).toBe(originalLink)
    expect(copy).toBe(originalCopy)
    expect(link?.dataset.path).toBe("run-wz3-tests.wls")
    expect(link?.getAttribute("href")).toBe("opencode-file:run-wz3-tests.wls")
    expect(link?.classList.contains("external-link")).toBe(false)
    expect(link?.hasAttribute("target")).toBe(false)
    expect(link?.querySelectorAll("[data-file-link-icon]")).toHaveLength(1)
  })

  test("reads all formula heights before writing any copy buttons", () => {
    const root = document.createElement("div")
    root.innerHTML = Array.from(
      { length: 20 },
      (_, i) =>
        `<div data-component="markdown-math"><div data-slot="markdown-math-viewport"><span class="katex-display" data-opencode-math-tex="x_${i}">formula</span></div></div>`,
    ).join("")
    const wrappers = Array.from(root.children)
    let reads = 0
    for (const [i, wrapper] of wrappers.entries()) {
      Object.defineProperty(wrapper, "offsetHeight", {
        get() {
          expect(root.querySelectorAll("button")).toHaveLength(0)
          reads++
          return i % 2 ? 200 : 80
        },
      })
    }
    decorateMarkdown(root, labels)
    expect(reads).toBe(20)
    expect(root.querySelectorAll('button[data-position="top"]')).toHaveLength(20)
    expect(root.querySelectorAll('button[data-position="bottom"]')).toHaveLength(10)
    console.info(`[markdown-decoration-test] formulas=${reads} readsBeforeWrites=true`)
  })

  test("reuses wrappers and buttons across decoration and removes an obsolete bottom button", () => {
    const root = document.createElement("div")
    root.innerHTML =
      '<pre><code>hello</code></pre><span class="katex-display" data-opencode-math-tex="x">formula</span>'
    decorateMarkdown(root, labels)
    const code = root.querySelector('[data-component="markdown-code"]')!
    const math = root.querySelector('[data-component="markdown-math"]')!
    const top = math.querySelector<HTMLButtonElement>('button[data-position="top"]')!
    let height = 200
    Object.defineProperty(math, "offsetHeight", { get: () => height })
    decorateMarkdown(root, labels)
    expect(math.querySelectorAll("button")).toHaveLength(2)
    height = 80
    decorateMarkdown(root, labels)
    expect(root.querySelector('[data-component="markdown-code"]')).toBe(code)
    expect(root.querySelectorAll('[data-component="markdown-math"]')).toHaveLength(1)
    expect(math.querySelectorAll("button")).toHaveLength(1)
    expect(math.querySelector("button")).toBe(top)
    expect(math.getAttribute("data-opencode-math-tex")).toBe("x")
    expect(code.querySelectorAll("button")).toHaveLength(1)
  })
})
