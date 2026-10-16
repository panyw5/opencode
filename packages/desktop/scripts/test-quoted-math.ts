import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const tex = [
  String.raw`e^{3\pi ia}L+e^{2\pi ia}A+e^{\pi ia}B+C=0.`,
  String.raw`e^{-3\pi ia}L+e^{-2\pi ia}A+e^{-\pi ia}B+C=0.`,
  "x>0, y<1",
]
const text = tex.map((formula) => `> Contour\n> $$\n> ${formula}\n> $$\n> **After**`).join("\n\n")

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const markdownPath = `/@fs${resolve(import.meta.dir, "../../ui/src/components/markdown.tsx")}`
  const markedPath = `/@fs${resolve(import.meta.dir, "../../ui/src/context/marked.tsx")}`
  try {
    for (const native of [false, true]) {
      const setup = await cdp.evaluate<string>(`(async () => {
        window.__quotedMathTest?.cleanup();
        document.querySelectorAll("#quoted-math-regression").forEach(node => node.remove());
        const resources = performance.getEntriesByType("resource").map(item => item.name);
        const { render, createComponent } = await import(resources.find(url => url.includes("/solid-js_web.js")));
        const { createStore } = await import(resources.find(url => url.includes("/solid-js_store.js")));
        const { Markdown } = await import(${JSON.stringify(markdownPath)});
        // Vite can retain a hot-update query even after a page reload.
        const source = await (await fetch(${JSON.stringify(markdownPath)})).text();
        const markedUrl = source.split('import { useMarked } from "')[1]?.split('"')[0];
        const { MarkedProvider } = await import(markedUrl ?? ${JSON.stringify(markedPath)});
        const host = document.createElement("div");
        host.id = "quoted-math-regression";
        host.style.cssText = "position:fixed;inset:60px 120px;overflow:auto;z-index:10000;padding:24px;background:var(--background-base)";
        document.body.append(host);
        const [state, setState] = createStore({ text: "", streaming: true });
        const dispose = render(() => createComponent(MarkedProvider, {
          nativeParser: ${native ? "(text) => window.api.parseMarkdownCommand(text)" : "undefined"},
          mathOutput: "html",
          get children() { return createComponent(Markdown, {
            get text() { return state.text; }, get streaming() { return state.streaming; },
            instant: true, eager: true, cacheKey: "quoted-math-regression-${native}",
          }); }
        }), host);
        window.__quotedMathTest = { setState, cleanup() { dispose(); host.remove(); } };
        return "ready";
      })().catch(error => error.stack ?? String(error))`)
      assert.equal(setup, "ready")
      for (let offset = 19; offset < text.length + 19; offset += 19) {
        await cdp.evaluate(`window.__quotedMathTest.setState("text", ${JSON.stringify(text.slice(0, offset))})`)
        await Bun.sleep(25)
      }
      for (const streaming of [true, false]) {
        await cdp.evaluate(`window.__quotedMathTest.setState("streaming", ${streaming})`)
        let snapshot: { tex: string[]; quotes: number; strong: number; errors: number } | undefined
        for (let attempt = 0; attempt < 60; attempt++) {
          snapshot = await cdp.evaluate(`(() => {
            const root = document.getElementById("quoted-math-regression");
            return {
              tex: [...root.querySelectorAll(".katex-display")].map(el => el.getAttribute("data-opencode-math-tex")),
              quotes: root.querySelectorAll("blockquote .katex-display").length,
              strong: root.querySelectorAll("strong").length,
              errors: root.querySelectorAll(".katex-error").length,
            };
          })()`)
          if (snapshot?.tex.length === tex.length && snapshot.strong === tex.length) break
          await Bun.sleep(100)
        }
        if (snapshot?.tex.length !== tex.length) {
          const html = await cdp.evaluate<string>('document.getElementById("quoted-math-regression").innerHTML')
          console.log(`[quoted-math-test] failed DOM=${html}`)
        }
        assert.deepEqual(snapshot?.tex, tex)
        assert.equal(snapshot?.quotes, tex.length)
        assert.equal(snapshot?.strong, tex.length)
        assert.equal(snapshot?.errors, 0)
        console.log(`[quoted-math-test] PASS native=${native} streaming=${streaming} formulas=${tex.length}`)
      }
    }
    const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-quoted-math.png", Buffer.from(screenshot.data, "base64"))
  } finally {
    await cdp.evaluate("window.__quotedMathTest?.cleanup(); delete window.__quotedMathTest")
  }
})
