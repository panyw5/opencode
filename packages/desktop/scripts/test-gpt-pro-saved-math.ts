import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const base = `/@fs${resolve(import.meta.dir, "../../ui/src")}/`
const jobID = Bun.argv[2]

await withCdp(async (cdp) => {
  try {
    const setup = await cdp.evaluate(`(async () => {
      const jobs = await window.api.gptPro.list();
      const job = jobs.find(j => j.phase === 'completed' && (!${JSON.stringify(jobID ?? "")} || j.id === ${JSON.stringify(jobID ?? "")}));
      if (!job) throw new Error('No completed consultation is available for this test');
      const [directory, sessionID] = job.owner.split('\\n');
      const full = await window.api.gptPro.command({action:'read', id:job.id, owner:{directory,sessionID}});
      const resources = performance.getEntriesByType('resource').map(r=>r.name);
      const {render, createComponent} = await import(resources.find(u=>u.includes('/solid-js_web.js')));
      const path = ${JSON.stringify(`${base}components/markdown.tsx`)};
      const {Markdown} = await import(path);
      const source = await (await fetch(path)).text();
      const {MarkedProvider} = await import(source.split('import { useMarked } from "')[1].split('"')[0]);
      const {gptProMarkdown} = await import(${JSON.stringify(`${base}components/gpt-pro-markdown.ts`)});
      const host = document.createElement('div');
      host.id = 'saved-math-test';
      host.style.cssText = 'position:fixed;inset:60px;z-index:10000;overflow:auto;padding:24px;background:var(--background-base)';
      document.body.append(host);
      const text = gptProMarkdown(full.html,full.text);
      window.__savedMathDispose = render(()=>createComponent(MarkedProvider, {
        nativeParser:text=>window.api.parseMarkdownCommand(text), mathOutput:'html',
        get children(){return createComponent(Markdown,{text,eager:true,instant:true,fileLinks:false})}
      }),host);
      return {id:full.id, annotations:(full.html.match(/application\\/x-tex/g)||[]).length};
    })()`)
    console.log(`[saved-math-test] loaded ${JSON.stringify(setup)}`)
    let snapshot: { formulas: number; errors: number; headings: number; text: number } | undefined
    for (let i = 0; i < 100; i++) {
      snapshot = await cdp.evaluate(`(() => {
        const root=document.getElementById('saved-math-test');
        return {formulas:root.querySelectorAll('[data-opencode-math-tex]').length,errors:root.querySelectorAll('.katex-error').length,headings:root.querySelectorAll('h1,h2,h3').length,text:root.innerText.length};
      })()`)
      if (snapshot!.formulas > 0) break
      await Bun.sleep(100)
    }
    assert.ok(snapshot!.formulas > 100)
    assert.equal(snapshot!.errors, 0)
    assert.ok(snapshot!.headings > 0)
    console.log(`[saved-math-test] PASS ${JSON.stringify(snapshot)}`)
  } finally {
    await cdp.evaluate(
      "window.__savedMathDispose?.(); document.getElementById('saved-math-test')?.remove(); delete window.__savedMathDispose",
    )
  }
})
