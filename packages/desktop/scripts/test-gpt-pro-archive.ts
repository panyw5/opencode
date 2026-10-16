import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const jobID = Bun.argv[2]
assert.match(jobID ?? "", /^gpt_[a-f0-9-]+$/i, "Usage: bun scripts/test-gpt-pro-archive.ts <consultation-id>")
const base = `/@fs${resolve(import.meta.dir, "../../ui/src")}/`

await withCdp(async (cdp) => {
  try {
    const setup = await cdp.evaluate(`(async () => {
      const existingPreviews=new Set(document.querySelectorAll('[data-testid="gpt-pro-result-preview"]'));
      window.__archiveTestRoot=()=>[...document.querySelectorAll('[data-testid="gpt-pro-result-preview"]')].find(node=>!existingPreviews.has(node));
      const resources=performance.getEntriesByType('resource').map(r=>r.name);
      const {render,createComponent}=await import(resources.find(u=>u.includes('/solid-js_web.js')));
      const {createStore}=await import(resources.find(u=>u.includes('/solid-js_store.js')));
      const base=${JSON.stringify(base)};
      const markdownSource=await (await fetch(base+'components/markdown.tsx')).text();
      const {MarkedProvider}=await import(markdownSource.split('import { useMarked } from "')[1].split('"')[0]);
      const {DialogProvider}=await import(base+'context/dialog.tsx');
      const previewSource=await (await fetch(base+'components/gpt-pro-result-preview.tsx')).text();
      const {I18nProvider}=await import(previewSource.split('import { useI18n } from "')[1].split('"')[0]);
      const translationQuery='?archiveTest='+Date.now();
      const [locale,setLocale]=createStore({dict:{...(await import(base+'i18n/en.ts'+translationQuery)).dict}});
      window.__archiveTestLocale=async code=>{
        const {dict}=await import(base+'i18n/'+code+'.ts'+translationQuery);
        setLocale('dict',()=>({...dict}));
        return dict['ui.tool.gptPro.openOriginal'];
      };
      const {GptProTool}=await import(base+'components/gpt-pro-tool.tsx');
      const host=document.createElement('div');host.id='gpt-pro-archive-test';
      host.style.cssText='position:fixed;inset:100px;z-index:49;padding:24px;background:var(--background-base)';
      document.body.append(host);
      window.__archiveTestDispose=render(()=>createComponent(MarkedProvider,{
        nativeParser:text=>window.api.parseMarkdownCommand(text),mathOutput:'html',
        get children(){return createComponent(I18nProvider,{
          value:{locale:()=> 'en',t:key=>locale.dict[key]??key},
          get children(){return createComponent(DialogProvider,{
          get children(){return createComponent(GptProTool,{
            status:'completed',input:{},metadata:{consultation_id:${JSON.stringify(jobID)},phase:'generating',background:true},
          })}
        })}})}
      }),host);
      return 'ready';
    })()`)
    assert.equal(setup, "ready")
    let card = ""
    for (let i = 0; i < 50; i++) {
      card = await cdp.evaluate<string>("document.getElementById('gpt-pro-archive-test').innerText")
      if (card.includes("Completed")) break
      await Bun.sleep(100)
    }
    assert.ok(card.includes("Completed"), card)
    await cdp.evaluate(
      "[...document.querySelectorAll('#gpt-pro-archive-test button')].find(b=>b.textContent.trim()==='View').click()",
    )
    let result: { text: number; formulas: number; errors: number; fallback: boolean } | undefined
    for (let i = 0; i < 100; i++) {
      result = await cdp.evaluate(`(() => {
        const root=window.__archiveTestRoot();
        return root && {text:root.innerText.length,formulas:root.querySelectorAll('.katex').length,
          errors:root.querySelectorAll('.katex-error').length,fallback:root.querySelector('[data-testid="gpt-pro-result-text-fallback"]')?.getAttribute('aria-hidden')==='false'};
      })()`)
      if (result?.formulas && !result.fallback) break
      await Bun.sleep(100)
    }
    assert.ok(result!.formulas > 50)
    assert.equal(result!.errors, 0)
    assert.equal(result!.fallback, false)
    for (const locale of [
      "ar",
      "br",
      "bs",
      "da",
      "de",
      "en",
      "es",
      "fr",
      "ja",
      "ko",
      "no",
      "pl",
      "ru",
      "th",
      "tr",
      "uk",
      "zh",
      "zht",
    ]) {
      const localized = await cdp.evaluate<{ expected: string; buttons: string[] }>(`(async () => {
        const expected=await window.__archiveTestLocale(${JSON.stringify(locale)});
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const dialog=window.__archiveTestRoot().closest('[data-slot="dialog-content"]');
        const buttons=[...dialog.querySelectorAll('button')].map(button=>button.textContent.trim());
        return {expected,buttons};
      })()`)
      assert.ok(
        localized.buttons.includes(localized.expected),
        `Missing localized original-page button: ${locale} ${JSON.stringify(localized)}`,
      )
    }
    await cdp.evaluate("window.__archiveTestLocale('en')")
    console.log("[gpt-pro-archive-test] PASS original-page button in all 18 locales")
    const normal = await cdp.evaluate<{ width: number; height: number }>(`(() => {
      const container=window.__archiveTestRoot().closest('[data-slot="dialog-container"]');
      const rect=container.getBoundingClientRect();
      return {width:rect.width,height:rect.height};
    })()`)
    await cdp.evaluate(
      `window.__archiveTestRoot().closest('[data-slot="dialog-content"]').querySelector('[aria-label="Maximize preview"]').click()`,
    )
    let enlarged: { width: number; height: number; viewportWidth: number; viewportHeight: number } | undefined
    for (let i = 0; i < 30; i++) {
      enlarged = await cdp.evaluate(`(() => {
        const rect=window.__archiveTestRoot().closest('[data-slot="dialog-container"]').getBoundingClientRect();
        return {width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight};
      })()`)
      if (Math.abs(enlarged!.width - enlarged!.viewportWidth * 0.9) < 1) break
      await Bun.sleep(30)
    }
    assert.ok(enlarged!.width > normal.width)
    assert.ok(enlarged!.height > normal.height)
    assert.ok(Math.abs(enlarged!.height - enlarged!.viewportHeight * 0.95) < 1)
    await cdp.evaluate(
      `window.__archiveTestRoot().closest('[data-slot="dialog-content"]').querySelector('[aria-label="Restore preview"]').click()`,
    )
    let restored = 0
    for (let i = 0; i < 30; i++) {
      restored = await cdp.evaluate<number>(
        `window.__archiveTestRoot().closest('[data-slot="dialog-container"]').getBoundingClientRect().width`,
      )
      if (Math.abs(restored - normal.width) < 1) break
      await Bun.sleep(30)
    }
    assert.ok(Math.abs(restored - normal.width) < 1)
    console.log(
      `[gpt-pro-archive-test] PASS maximize/restore normal=${normal.width} maximized=${enlarged!.width} restored=${restored}`,
    )
    console.log(`[gpt-pro-archive-test] PASS stale card refreshed; original saved dialog ${JSON.stringify(result)}`)
    const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-gpt-pro-archive.png", Buffer.from(screenshot.data, "base64"))
  } finally {
    await cdp.evaluate(
      "window.__archiveTestDispose?.(); document.getElementById('gpt-pro-archive-test')?.remove(); delete window.__archiveTestDispose; delete window.__archiveTestLocale; delete window.__archiveTestRoot",
    )
  }
})
