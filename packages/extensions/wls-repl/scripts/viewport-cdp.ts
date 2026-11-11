// Run against an already-running development Electron renderer on :9222.
// Exercises the real Solid viewer with a deterministic host bridge; real kernel
// round trips are covered separately by test/bridge-integration.test.ts.
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { withCdp } from "../../../desktop/scripts/cdp"

const built = process.env.WLS_CDP_DIST === "1"
const directory = process.env.WLS_CDP_DIRECTORY ?? resolve(import.meta.dir, "..")
const source = `/@fs${resolve(directory, built ? "dist/web/index.js" : "src/web.tsx")}?wls-cdp=${Date.now()}`
const css = `/@fs${resolve(directory, "dist/web/index.css")}?direct`
await withCdp(async (client, target) => {
  assert.ok(target.url.includes("localhost:"), "Only use the development renderer")
  try {
    const result = await client.evaluate<any>(`(async () => {
      const source = ${JSON.stringify(source)};
      const transformed = await fetch(source).then(r => r.text());
      const moduleURL = name => [...transformed.matchAll(/from "([^"]+)"/g)].map(m => m[1]).find(url => url.includes(name));
      const webURL = moduleURL('solid-js_web.js');
      const solidURL = moduleURL('/solid-js.js');
      const built = ${built};
      const shared = globalThis.__OPENCODE_EXTENSION_HOST__?.modules;
      const { render } = built ? shared['solid-js/web'] : await import(webURL);
      const { createSignal, createComponent } = built ? shared['solid-js'] : await import(solidURL);
      const mod = await import(source);
      let artifactStyle;
      const sourceSheets = built ? [...document.querySelectorAll('style[data-vite-dev-id]')].filter(e => e.dataset.viteDevId?.includes('/wls-repl/src/web.css')).map(e => ({sheet:e.sheet, disabled:e.sheet.disabled})) : [];
      for (const {sheet} of sourceSheets) sheet.disabled = true;
      if (built) {
        artifactStyle = document.createElement('style');
        artifactStyle.textContent = await fetch(${JSON.stringify(css)}).then(r => r.text());
        document.head.append(artifactStyle);
      }
      const logs = [];
      const calls = [];
      let receive;
      const deactivate = await mod.default.activate({
        log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(k => [k, text => logs.push(text)])),
        fileViewers: { register: () => ({ dispose() {} }) },
        events: { on: (_, listener) => { receive = listener; return { dispose() {} }; } },
        rpc: { call: async (method, input) => { calls.push({method, input}); return {started: true}; } },
      });
      const root = document.createElement('div');
      root.id = 'wls-viewport-cdp';
      root.style.cssText = 'position:fixed;inset:20px;z-index:99999;background:var(--background-base)';
      document.body.append(root);
      let text = Array.from({length:100000}, (_, i) => i % 3 === 0 ? '' : 'value' + (i+1) + ' = ' + (i+1) + ';').join('\\n');
      const [revision, setRevision] = createSignal(0);
      const start = performance.now();
      const originalLang = document.documentElement.lang;
      const surface = document.createElement('div');
      surface.className = 'oc-extension-root relative flex min-h-full flex-col';
      surface.dataset.extension = 'local.wls-repl';
      const toolbar = document.createElement('div');
      toolbar.dataset.slot = 'file-viewer-toolbar';
      toolbar.textContent = 'Open with';
      surface.append(toolbar);
      root.append(surface);
      const dispose = render(() => createComponent(mod.WlsViewer, {
        file: {absolutePath:'/tmp/viewport-cdp.wls'}, text: () => text, revision,
        readText: async () => text, showSource() {},
      }), surface, toolbar.nextSibling);
      window.__wlsViewportCleanup = () => { document.documentElement.lang = originalLang; dispose(); deactivate(); root.remove(); artifactStyle?.remove(); for (const {sheet,disabled} of sourceSheets) sheet.disabled = disabled; delete window.__wlsViewportCleanup; };
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const waitHighlight = async () => {
        const deadline = performance.now() + 10000;
        while (!root.querySelector('.oc-wls-line-text [data-token="number"]')) {
          if (performance.now() > deadline) throw new Error('Syntax highlighting did not become ready');
          await frame();
        }
      };
      await frame();
      await waitHighlight();
      const mountMs = performance.now() - start;
      const code = root.querySelector('.oc-wls-code');
      const rows = () => [...root.querySelectorAll('.oc-wls-line')];
      const check = (ok, message) => { if (!ok) throw new Error(message + ' logs=' + JSON.stringify(logs)); };
      const verifyRows = () => {
        const list = rows();
        check(list.length < 100, 'unbounded DOM: ' + list.length);
        for (const el of list) {
          const n = Number(el.dataset.line);
          const expected = (n-1) % 3 === 0 ? ' ' : 'value' + n + ' = ' + n + ';';
          check(el.querySelector('pre').textContent === expected, 'wrong content at ' + n);
        }
        return list.length;
      };
      const topRows = verifyRows();
      check(getComputedStyle(toolbar).display === 'none', 'redundant host toolbar still visible');
      const input = root.querySelector('.oc-wls-input');
      const inputBottom = input.getBoundingClientRect().bottom;
      const buttons = () => [...root.querySelectorAll('.oc-wls-actions button')];
      check(buttons().every(b => getComputedStyle(b).borderRadius === '999px'), 'controls are not pills');
      document.documentElement.lang = 'zh';
      await frame();
      check(buttons()[0].textContent.trim() === '运行', 'Chinese label missing');
      check(input.placeholder === '在内核中计算表达式', 'Chinese placeholder missing');
      document.documentElement.lang = 'ja';
      await frame();
      check(buttons()[0].textContent.trim() === '実行', 'live Japanese switch failed');
      document.documentElement.lang = 'zht';
      await frame();
      check(buttons()[0].textContent.trim() === '執行', 'Traditional Chinese label missing');
      document.documentElement.lang = 'de';
      await frame();
      check(buttons()[0].textContent.trim() === 'Ausführen', 'German label missing');
      document.documentElement.lang = 'ar';
      await frame();
      check(buttons()[0].textContent.trim() === 'تشغيل', 'Arabic label missing');
      check(getComputedStyle(code).direction === 'ltr', 'Source must remain left-to-right');
      document.documentElement.lang = 'en';
      await frame();
      code.scrollTop = 1000000;
      code.dispatchEvent(new Event('scroll'));
      await frame();
      const middleRows = verifyRows();
      await waitHighlight();
      check(root.querySelector('.oc-wls-line-text [data-token="number"]'), 'middle syntax highlight missing');
      check(Math.abs(input.getBoundingClientRect().bottom - inputBottom) < 1, 'input moved while code scrolled');
      check(surface.scrollHeight <= surface.clientHeight + 1, 'viewer overflows its host');
      const number = Number(rows()[20].dataset.line);
      rows()[20].querySelector('button').click();
      check(root.querySelector('[data-line="' + number + '"] button').classList.contains('has-breakpoint'), 'breakpoint missing');
      code.scrollTop = 0;
      code.dispatchEvent(new Event('scroll'));
      await frame();
      code.scrollTop = 1000000;
      code.dispatchEvent(new Event('scroll'));
      await frame();
      check(root.querySelector('[data-line="' + number + '"] button').classList.contains('has-breakpoint'), 'breakpoint lost after recycling');
      receive({path:'/tmp/viewport-cdp.wls', kind:'protocol', type:'paused', line:90000, variables:{}});
      await frame();
      const paused = root.querySelector('[data-line="90000"]');
      check(paused?.classList.contains('is-paused'), 'offscreen pause not mounted');
      const bounds = paused.getBoundingClientRect();
      const viewport = code.getBoundingClientRect();
      check(Math.abs((bounds.top+bounds.bottom)/2 - (viewport.top+viewport.bottom)/2) < 2, 'pause not centered');
      receive({path:'/tmp/viewport-cdp.wls', kind:'protocol', type:'done'});
      code.scrollTop = code.scrollHeight;
      code.dispatchEvent(new Event('scroll'));
      await frame();
      verifyRows();
      check(rows().at(-1).dataset.line === '100000', 'last line missing');
      await waitHighlight();
      root.style.height = '400px';
      await frame();
      verifyRows();
      const resizedInputBottom = input.getBoundingClientRect().bottom;
      for (let i = 0; i < 100; i++) receive({path:'/tmp/viewport-cdp.wls', kind:'output', text:'output ' + i});
      await frame();
      const output = root.querySelector('.oc-wls-console-entries');
      check(output.scrollHeight > output.clientHeight, 'output does not scroll independently');
      output.scrollTop = output.scrollHeight;
      await frame();
      check(Math.abs(input.getBoundingClientRect().bottom - resizedInputBottom) < 1, 'input moved while output scrolled');
      check(input.getBoundingClientRect().bottom <= root.getBoundingClientRect().bottom, 'input outside viewport');
      text = 'a = 1;\\na + 1';
      setRevision(1);
      await frame();
      check(code.dataset.virtual === 'false' && rows().length === 2, 'refresh to small file failed');
      root.querySelector('button[data-component="button"]').click();
      await frame();
      check(calls[0]?.method === 'kernel.run' && calls[0].input.code === text, 'Run did not send current file');
      input.value = '1 + 1';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
      await frame();
      check(calls.at(-1)?.method === 'kernel.eval' && calls.at(-1).input.code === '1 + 1', 'REPL submit failed');
      receive({path:'/tmp/viewport-cdp.wls', kind:'protocol', type:'eval-result', ok:true, text:'2'});
      await frame();
      check([...root.querySelectorAll('.oc-wls-entry[data-kind="result"]')].at(-1)?.textContent === '2', 'REPL result missing');
      text = '(* outer\\n(* nested *)\\nend *) Sin[x];\\n"multi\\nline" + Pi';
      setRevision(2);
      await frame();
      check(rows()[1].querySelector('[data-token="comment"]')?.textContent === '(* nested *)', 'nested multiline comment failed');
      check(rows()[2].querySelector('[data-token="function"]')?.textContent === 'Sin', 'comment end state failed');
      check(rows()[4].querySelector('[data-token="string"]')?.textContent === 'line"', 'multiline string failed');
      check(rows()[4].querySelector('[data-token="constant"]')?.textContent === 'Pi', 'string end state failed');
      check(logs.every(text => typeof text === 'string'), 'frontend log must be a string');
      return {builtArtifact:built, mountMs, topRows, middleRows, breakpoint:number, pausedLine:90000, finalLine:100000, refreshedRows:rows().length, syntaxHighlight:true, crossLineSyntax:true, pinnedInput:true, pills:true, locales:['en','zh','zht','ja','de','ar'], logs};
    })().catch(error => ({error: String(error), stack: error?.stack}))`)
    console.log(JSON.stringify(result, null, 2))
    assert.ok(!result.error, result.error)
    assert.ok(result.topRows < 100)
  } finally {
    await client.evaluate("window.__wlsViewportCleanup?.()")
  }
})
