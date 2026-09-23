import { describe, expect, test } from "bun:test"
import { decorateMarkdown } from "@opencode-ai/ui/markdown"

const labels = { copy: "Copy", copied: "Copied" }

describe("markdown decoration", () => {
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
