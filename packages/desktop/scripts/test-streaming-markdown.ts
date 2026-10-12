import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const markdownPath = `/@fs${resolve(import.meta.dir, "../../ui/src/components/markdown.tsx")}`
  const markedPath = `/@fs${resolve(import.meta.dir, "../../ui/src/context/marked.tsx")}`
  try {
    await cdp.evaluate(`(async () => {
      const resources = performance.getEntriesByType("resource").map(item => item.name);
      const { render } = await import(resources.find(url => url.includes("/solid-js_web.js")));
      const { createStore } = await import(resources.find(url => url.includes("/solid-js_store.js")));
      const { Markdown } = await import(${JSON.stringify(markdownPath)});
      const { MarkedProvider } = await import(${JSON.stringify(markedPath)});
      const previousDebug = window.__opencodeMarkdownDebug;
      window.__opencodeMarkdownDebug = true;
      const host = document.createElement("div");
      host.id = "streaming-markdown-regression";
      host.style.cssText = "position:fixed;left:32px;top:100px;width:680px;height:700px;overflow:auto;z-index:10000;padding:24px;background:var(--background-base)";
      document.body.append(host);
      const [state, setState] = createStore({ text: "", streaming: true });
      const dispose = render(() => MarkedProvider({ get children() {
        return Markdown({ get text() { return state.text; }, get streaming() { return state.streaming; },
          instant: true, eager: true, cacheKey: "streaming-regression" });
      }}), host);
      window.__streamingMarkdownRegression = { setState, cleanup() { dispose(); host.remove(); window.__opencodeMarkdownDebug = previousDebug; } };
    })()`)
    const blocks = Array.from(
      { length: 24 },
      (_, i) =>
        `## Section ${i + 1}\n\nMARKER_${i}_START paragraph with **bold** and \`inline code\`.\n\n- item ${i} one\n- item ${i} two\n\n\`\`\`ts\nconst value${i} = ${i}\n\`\`\`\n\nMARKER_${i}_END\n\n`,
    )
    let text = ""
    for (let block = 0; block < blocks.length; block++) {
      const chunk = blocks[block]!
      for (let offset = 0; offset < chunk.length; offset += 17) {
        text += chunk.slice(offset, offset + 17)
        await cdp.evaluate(`window.__streamingMarkdownRegression.setState("text", ${JSON.stringify(text)})`)
        await Bun.sleep(25)
        const snapshot = await cdp.evaluate<{ text: string; headings: number; bold: number; code: number }>(`(() => {
          const root = document.querySelector("#streaming-markdown-regression [data-component=markdown]");
          return { text: root.textContent, headings: root.querySelectorAll("h2").length,
            bold: root.querySelectorAll("strong").length, code: root.querySelectorAll("pre").length };
        })()`)
        for (let prior = 0; prior < block; prior++) {
          assert.ok(
            snapshot.text.includes(`MARKER_${prior}_START`),
            `lost start of block ${prior} at block ${block} offset ${offset}`,
          )
          assert.ok(
            snapshot.text.includes(`MARKER_${prior}_END`),
            `lost end of block ${prior} at block ${block} offset ${offset}`,
          )
        }
        assert.ok(snapshot.headings >= block, "completed headings remain rendered")
        assert.ok(snapshot.bold >= block, "completed emphasis remains rendered")
        assert.ok(snapshot.code >= block, "completed fences remain rendered")
      }
      console.log(`[streaming-markdown-test] preserved blocks=${block + 1} chars=${text.length}`)
    }
    await cdp.evaluate('window.__streamingMarkdownRegression.setState("streaming", false)')
    await Bun.sleep(1000)
    const finalText = await cdp.evaluate<string>('document.getElementById("streaming-markdown-regression").textContent')
    for (let i = 0; i < blocks.length; i++) assert.ok(finalText.includes(`MARKER_${i}_END`))
    console.log("[streaming-markdown-test] PASS streaming and completed output")
  } finally {
    await cdp.evaluate("window.__streamingMarkdownRegression?.cleanup(); delete window.__streamingMarkdownRegression")
  }
})
