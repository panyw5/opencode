// Run against an already-running development Electron renderer on :9222.
// Mounts the real Solid viewer with a reactive settings bridge and exercises
// the word-wrap toggle and font-size controls.
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { withCdp } from "../../../desktop/scripts/cdp"

const directory = process.env.WLS_CDP_DIRECTORY ?? resolve(import.meta.dir, "..")
const source = `/@fs${resolve(directory, "src/web.tsx")}?wls-cdp=${Date.now()}`
await withCdp(async (client, target) => {
  assert.ok(target.url.includes("localhost:"), "Only use the development renderer")
  const result = await client.evaluate<any>(`(async () => { try {
    const source = ${JSON.stringify(source)};
    const transformed = await fetch(source).then(r => r.text());
    const moduleURL = name => [...transformed.matchAll(/from "([^"]+)"/g)].map(m => m[1]).find(url => url.includes(name));
    const webURL = moduleURL('solid-js_web.js');
    const solidURL = moduleURL('/solid-js.js');
    const { render } = await import(webURL);
    const { createSignal, createComponent } = await import(solidURL);
    const mod = await import(source);
    const patches = [];
    const [store, setStore] = createSignal({ wordWrap: true, fontSize: 12.5 });
    const deactivate = await mod.default.activate({
      log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(k => [k, () => {}])),
      fileViewers: { register: () => ({ dispose() {} }) },
      events: { on: () => ({ dispose() {} }) },
      rpc: { call: async () => ({ started: true }) },
      settings: {
        get: (key) => () => store()[key],
        update: async (patch) => { patches.push(patch); setStore(s => ({ ...s, ...patch })); },
      },
    });
    const root = document.createElement('div');
    root.id = 'wls-settings-cdp';
    root.style.cssText = 'position:fixed;inset:20px;z-index:99999;background:var(--background-base)';
    document.body.append(root);
    const surface = document.createElement('div');
    surface.className = 'oc-extension-root relative flex min-h-full flex-col';
    root.append(surface);
    const text = 'short = 1;\\n' + 'long = "' + 'x'.repeat(4000) + '";\\n' + 'tail = 2;';
    const dispose = render(() => createComponent(mod.WlsViewer, {
      file: { absolutePath: '/tmp/settings-cdp.wls' }, text: () => text, revision: () => 0,
      readText: async () => text, showSource() {},
    }), surface);
    window.__wlsSettingsCleanup = () => { dispose(); deactivate(); root.remove(); delete window.__wlsSettingsCleanup; };
    const frame = () => new Promise(r => setTimeout(r, 50));
    await frame();
    const code = root.querySelector('.oc-wls-code');
    const lineText = () => root.querySelector('.oc-wls-line-text');
    const wrapButton = () => root.querySelector('[data-action="toggle-wrap"]');
    const sizeLabel = () => root.querySelector('.oc-wls-font-size');
    const fontButtons = () => [...root.querySelectorAll('.oc-wls-font-controls button')];
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    check(!!wrapButton(), 'word wrap toggle missing');
    check(code.dataset.wrap === 'on', 'wrap should default on');
    check(getComputedStyle(lineText()).whiteSpace === 'pre-wrap', 'wrap on must use pre-wrap');
    check(code.style.getPropertyValue('--wls-font-size') === '12.5px', 'font size var not 12.5px');
    check(sizeLabel().textContent === '12.5', 'font size label wrong');
    wrapButton().click();
    await frame();
    check(patches.length === 1 && patches[0].wordWrap === false, 'wrap patch not sent');
    check(code.dataset.wrap === 'off', 'wrap did not turn off');
    check(getComputedStyle(lineText()).whiteSpace === 'pre', 'wrap off must use pre');
    fontButtons()[1].click();
    await frame();
    check(patches.length === 2 && patches[1].fontSize === 13.5, 'font increase patch wrong');
    check(code.style.getPropertyValue('--wls-font-size') === '13.5px', 'font size var not updated');
    check(sizeLabel().textContent === '13.5', 'font size label not updated');
    fontButtons()[0].click();
    await frame();
    check(patches.length === 3 && patches[2].fontSize === 12.5, 'font decrease patch wrong');
    return { ok: true, patches };
    } catch (e) { return { ok: false, error: String(e && e.stack ? e.stack : e) }; }
  })()`)
  assert.equal(result?.ok, true, JSON.stringify(result))
  await client.evaluate(`window.__wlsSettingsCleanup?.()`)
  console.log("wls settings controls verified", result.patches)
})
