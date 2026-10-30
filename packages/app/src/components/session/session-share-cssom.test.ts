import { expect, test } from "bun:test"
import { shareHTML } from "./session-share-html"

test("keeps Chromium style rules exposing an empty cssRules list", async () => {
  const style = document.createElement("style")
  style.textContent = ".katex{font-size:1.21em}.unrelated{color:red}"
  document.head.append(style)
  const rule = style.sheet!.cssRules[0]
  Object.defineProperty(rule, "cssRules", { configurable: true, value: [] })
  const preview = document.createElement("div")
  preview.innerHTML = '<span class="katex">x</span>'
  document.body.append(preview)
  try {
    const html = await shareHTML(preview, "light")
    expect(html).toContain("font-size:")
    expect(html).not.toContain(".unrelated")
  } finally {
    style.remove()
    preview.remove()
  }
})
