import { expect, test } from "bun:test"
import { shareHTML } from "./session-share-html"

test("retains resolved highlighting, compact file SVG and offscreen math without controls", async () => {
  const preview = document.createElement("div")
  preview.style.cssText = "width:600px;background:rgb(20,20,20)"
  preview.innerHTML = `<pre><code><span style="color:rgb(210,30,60)">const</span> x = 1</code></pre>
    <a data-file-link><svg style="width:16px;height:16px"><use href="#share-test-icon"/></svg>file.ts</a>
    <div style="margin-top:5000px"><span class="katex" style="font-size:20px">x²</span></div><button>Copy</button>`
  const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  sprite.innerHTML = '<symbol id="share-test-icon" viewBox="0 0 16 16"><path d="M0 0h16v16z"/></symbol>'
  document.body.append(sprite, preview)
  try {
    const html = await shareHTML(preview, "dark")
    expect(html).toContain("color:rgb(210, 30, 60)")
    expect(html).toContain("width:16px")
    expect(html).toContain("height:16px")
    expect(html).toContain('href="#export-icon-0"')
    expect(html).toContain('id="export-icon-0"')
    expect(html).toContain("margin-top:5000px")
    expect(html).toContain("font-size:20px")
    expect(html).not.toContain("<button")
    expect(preview.querySelector("button")).not.toBeNull()
  } finally {
    preview.remove()
    sprite.remove()
  }
})
