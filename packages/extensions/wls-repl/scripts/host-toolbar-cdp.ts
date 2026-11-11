// Verify the real host boundary independently of the installed WLS CSS/version.
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { withCdp } from "../../../desktop/scripts/cdp"

const source = `/@fs${resolve(import.meta.dir, "../../../app/src/pages/session/file-viewer-content.ts")}?wls-host-cdp=${Date.now()}`
await withCdp(async (client, target) => {
  assert.ok(target.url.includes("localhost:"))
  const result = await client.evaluate<any>(`(async () => {
    const source = ${JSON.stringify(source)};
    const transformed = await fetch(source).then(r => r.text());
    const urls = [...transformed.matchAll(/from "([^"]+)"/g)].map(m => m[1]);
    const { render } = await import(urls.find(u => u.includes('solid-js_web.js')));
    const { createSignal } = await import(urls.find(u => u.includes('/solid-js.js')));
    const { createFileViewerContent } = await import(source);
    const host = document.createElement('div');
    document.body.append(host);
    const [entry, setEntry] = createSignal({id:'ext.local.wls-repl.wls-repl', owner:'local.wls-repl', component: () => document.createElement('section')});
    let dispose;
    try {
      dispose = render(() => createFileViewerContent({
        activeViewer:entry, loaded:()=>true, defaultContent:()=>document.createElement('div'),
        text:()=>'', revision:()=>0, file:()=>({absolutePath:'/tmp/host-toolbar.wls'}),
        setDirty(){}, onSave:()=>()=>{}, readBytes:async()=>new Uint8Array(), readText:async()=>'', showSource(){},
        path:()=>'/tmp/host-toolbar.wls', menu:()=>document.createElement('button'), openWith:()=>document.createElement('button'),
        onRenderError: e => console.info('[wls-host-cdp] expected render error',e), errorFallback:()=>document.createElement('div'),
      }), host);
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await frame();
      const row = () => host.querySelector('[data-slot="file-viewer-toolbar"]');
      const hidden = row().style.display === 'none' && getComputedStyle(row()).display === 'none';
      const pinned = host.firstElementChild.style.height === '100%' && host.firstElementChild.style.minHeight === '0px';
      setEntry({id:'other',owner:'other',component:()=>document.createElement('div')});
      await frame();
      const otherUnaffected = row().style.display === '';
      setEntry({id:'broken',owner:'local.wls-repl',component:()=>{throw new Error('intentional WLS failure')}});
      await frame();
      const recovery = row().style.display === '';
      return {hidden,pinned,otherUnaffected,recovery};
    } finally { dispose?.(); host.remove(); }
  })().catch(e => ({error:String(e),stack:e.stack}))`)
  console.log(JSON.stringify(result, null, 2))
  assert.ok(!result.error, result.error)
  for (const key of ["hidden", "pinned", "otherUnaffected", "recovery"]) assert.equal(result[key], true, key)
})
