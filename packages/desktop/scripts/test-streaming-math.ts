import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { Database } from "bun:sqlite"
import { withCdp } from "./cdp"

const fixture = process.env.OPENCODE_STREAM_PART
const database = fixture ? new Database(process.env.OPENCODE_STREAM_DB!, { readonly: true }) : undefined
const text = database
  ? (database.query("select json_extract(data, '$.text') as text from part where id = ?").get(fixture!) as { text: string }).text
  : String.raw`## First section

FIRST_MARKER proof outline:
$$
R_{ij},\qquad B_a=\sum_{j\ne a}R_{aj}F_j,\qquad B_0=\sum_{i<j}R_{ij}F_iF_j,
$$
SECOND_MARKER definition:
$$
F_j=\frac1{2\pi i}\partial_{z_j}\log\vartheta_4(z_j).
$$

- **Completed first item**
- **Completed second item**

## Second section

THIRD_MARKER identity:
$$
\boxed{f(u)f(v)-f(u+v)\bigl[f(u)+f(v)\bigr]+\frac{h(u)+h(v)+h(u+v)-c}{2}=0.}
$$

FINAL_MARKER completed proof.
`
database?.close()

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const markdown = `/@fs${resolve(import.meta.dir, "../../ui/src/components/markdown.tsx")}`
  const marked = `/@fs${resolve(import.meta.dir, "../../ui/src/context/marked.tsx")}`
  try {
    await cdp.evaluate(`(async () => {
      const resources = performance.getEntriesByType("resource").map(item => item.name);
      const { render } = await import(resources.find(url => url.includes("/solid-js_web.js")));
      const { createStore } = await import(resources.find(url => url.includes("/solid-js_store.js")));
      const { Markdown } = await import(${JSON.stringify(markdown)});
      const { MarkedProvider } = await import(${JSON.stringify(marked)});
      const host = document.createElement("div");
      host.id = "streaming-math-regression";
      host.style.cssText = "position:fixed;left:32px;top:100px;width:900px;height:700px;overflow:auto;z-index:10000;padding:24px;background:var(--background-base)";
      document.body.append(host);
      const [state, setState] = createStore({ text: "", streaming: true });
      const dispose = render(() => MarkedProvider({ get children() {
        return Markdown({ get text() { return state.text; }, get streaming() { return state.streaming; },
          instant: true, eager: true, cacheKey: "streaming-math-regression" });
      }}), host);
      window.__streamingMath = { setState, cleanup() { dispose(); host.remove(); } };
    })()`)
    let previousHeadings = 0
    let previousMath = 0
    for (let length = 1; length <= text.length; length += 7) {
      const source = text.slice(0, length)
      await cdp.evaluate(`window.__streamingMath.setState("text", ${JSON.stringify(source)})`)
      await Bun.sleep(30)
      const snapshot = await cdp.evaluate<{ text: string; headings: number; math: number; html: number }>(`(() => {
        const root = document.querySelector("#streaming-math-regression [data-component=markdown]");
        return { text: root.textContent, headings: root.querySelectorAll("h2").length,
          math: root.querySelectorAll(".katex-display").length, html: root.innerHTML.length };
      })()`)
      assert.ok(snapshot.headings >= previousHeadings, `headings vanished at chars=${length} ${JSON.stringify(snapshot)}`)
      assert.ok(snapshot.math >= previousMath, `math vanished at chars=${length} ${JSON.stringify(snapshot)}`)
      previousHeadings = snapshot.headings
      previousMath = snapshot.math
      if (length % 140 === 1) console.log(`[streaming-math-test] chars=${length} headings=${snapshot.headings} math=${snapshot.math} html=${snapshot.html}`)
    }
    await cdp.evaluate(`window.__streamingMath.setState("text", ${JSON.stringify(text)})`)
    await cdp.evaluate('window.__streamingMath.setState("streaming", false)')
    await Bun.sleep(1000)
    console.log(`[streaming-math-test] PASS chars=${text.length} headings=${previousHeadings} math=${previousMath}`)
  } finally {
    await cdp.evaluate("window.__streamingMath?.cleanup(); delete window.__streamingMath")
  }
})
