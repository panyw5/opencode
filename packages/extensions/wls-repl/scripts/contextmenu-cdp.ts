// Run against an already-running development Electron renderer on :9222.
// Mounts the real Solid viewer and exercises text selection and the
// right-click context menu (copy / copy path / prompt reference / breakpoint).
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
    const { createComponent } = await import(solidURL);
    const mod = await import(source);
    const deactivate = await mod.default.activate({
      log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(k => [k, () => {}])),
      fileViewers: { register: () => ({ dispose() {} }) },
      events: { on: () => ({ dispose() {} }) },
      rpc: { call: async () => ({ started: true }) },
      settings: { get: () => () => undefined, update: async () => {} },
    });
    const root = document.createElement('div');
    root.id = 'wls-contextmenu-cdp';
    root.style.cssText = 'position:fixed;inset:20px;z-index:99999;background:var(--background-base);height:600px';
    document.body.append(root);
    const surface = document.createElement('div');
    surface.className = 'oc-extension-root relative flex min-h-full flex-col';
    surface.style.height = '100%';
    root.append(surface);
    const text = 'alpha = 1\\nbeta = 2\\ngamma = 3\\n';
    const dispose = render(() => createComponent(mod.WlsViewer, {
      file: { path: 'tmp/menu-cdp.wls', absolutePath: '/tmp/menu-cdp.wls', directory: '/tmp', name: 'menu-cdp.wls', extension: 'wls' },
      text: () => text, revision: () => 0,
      readText: async () => text, showSource() {},
    }), surface);
    window.__wlsMenuCleanup = () => { dispose(); deactivate(); root.remove(); delete window.__wlsMenuCleanup; };
    const frame = () => new Promise(r => setTimeout(r, 80));
    await frame();
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const out = {};
    const code = surface.querySelector('.oc-wls-code');
    check(!!code, 'code area missing');
    out.userSelect = getComputedStyle(code).userSelect;
    check(out.userSelect === 'text', 'user-select not text: ' + out.userSelect);
    const lineEl = (n) => surface.querySelector('[data-line="' + n + '"] .oc-wls-line-text');
    check(!!lineEl(3), 'line 3 missing');

    const copied = [];
    try {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (t) => { copied.push(t); } },
        configurable: true,
      });
    } catch (e) {}
    const promptEvents = [];
    window.__wlsPromptEvents = promptEvents;
    window.addEventListener('opencode:prompt-context-add', (e) => promptEvents.push(e.detail));

    const openMenu = async (target, x = 200, y = 120) => {
      target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      await frame();
      return document.querySelector('.oc-wls-context-menu');
    };
    const menuItem = (menu, action) => menu.querySelector('[data-action="' + action + '"]');
    const activate = async (item) => { item.click(); await frame(); };
    const closeMenu = async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame(); };

    // 1. Right-click line 3: menu opens with all four items.
    let menu = await openMenu(lineEl(3));
    check(!!menu, 'context menu did not open on line 3');
    const labels = [...menu.querySelectorAll('.oc-wls-context-item')].map(i => i.textContent.trim());
    out.labels = labels;
    for (const action of ['wls-copy', 'wls-copy-path', 'wls-reference', 'wls-breakpoint']) {
      check(!!menuItem(menu, action), 'menu item missing: ' + action);
    }

    // 2. Add breakpoint on line 3 via the menu.
    await activate(menuItem(menu, 'wls-breakpoint'));
    await frame();
    check(!!surface.querySelector('[data-line="3"] .oc-wls-gutter.has-breakpoint'), 'breakpoint not toggled on line 3');

    // 3. Reopen: breakpoint item should now read as remove.
    menu = await openMenu(lineEl(3));
    check(!!menu, 'context menu did not reopen');
    out.bpLabelAfter = menuItem(menu, 'wls-breakpoint').textContent.trim();
    check(out.bpLabelAfter !== labels[3], 'breakpoint label did not change');
    await activate(menuItem(menu, 'wls-breakpoint'));
    await frame();
    check(!surface.querySelector('[data-line="3"] .oc-wls-gutter.has-breakpoint'), 'breakpoint not removed on line 3');

    // 4. Reference in prompt: single line target.
    menu = await openMenu(lineEl(3));
    await activate(menuItem(menu, 'wls-reference'));
    await frame();
    check(promptEvents.length === 1, 'prompt event not dispatched');
    out.detail = promptEvents[0];
    check(out.detail.path === 'tmp/menu-cdp.wls', 'prompt event path wrong: ' + out.detail.path);
    check(out.detail.directory === '/tmp', 'prompt event directory wrong');
    check(out.detail.selection?.startLine === 3 && out.detail.selection?.endLine === 3, 'prompt event selection wrong');
    check(out.detail.preview === 'gamma = 3', 'prompt event preview wrong: ' + out.detail.preview);

    // 5. Copy line text (no DOM selection -> clicked line).
    copied.length = 0;
    menu = await openMenu(lineEl(2));
    await activate(menuItem(menu, 'wls-copy'));
    await frame();
    out.copiedLine = copied[0];
    check(out.copiedLine === 'beta = 2', 'copy did not capture line text: ' + out.copiedLine);

    // 6. Copy file path.
    copied.length = 0;
    menu = await openMenu(lineEl(1));
    await activate(menuItem(menu, 'wls-copy-path'));
    await frame();
    out.copiedPath = copied[0];
    check(out.copiedPath === '/tmp/menu-cdp.wls', 'copy path wrong: ' + out.copiedPath);

    // 7. DOM selection across lines 1-2 drives both copy text and reference range.
    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStartBefore(lineEl(1).firstChild);
    range.setEndAfter(lineEl(2).lastChild);
    sel.addRange(range);
    menu = await openMenu(lineEl(2));
    await activate(menuItem(menu, 'wls-copy'));
    await frame();
    out.copiedSelection = copied[copied.length - 1];
    check((out.copiedSelection || '').includes('alpha = 1'), 'selection copy missed line 1: ' + JSON.stringify(out.copiedSelection));
    check((out.copiedSelection || '').includes('beta = 2'), 'selection copy missed line 2: ' + JSON.stringify(out.copiedSelection));
    menu = await openMenu(lineEl(2));
    await activate(menuItem(menu, 'wls-reference'));
    await frame();
    out.rangeDetail = promptEvents[promptEvents.length - 1];
    check(out.rangeDetail.selection?.startLine === 1 && out.rangeDetail.selection?.endLine === 2,
      'range reference wrong: ' + JSON.stringify(out.rangeDetail.selection));
    sel.removeAllRanges();
    delete window.__wlsPromptEvents;
    return { ok: true, ...out };
    } catch (e) { return { ok: false, error: String(e && e.stack ? e.stack : e) }; }
  })()`)
  assert.equal(result?.ok, true, JSON.stringify(result))
  await client.evaluate(`window.__wlsMenuCleanup?.()`)
  console.log("wls context menu verified", JSON.stringify(result, null, 2))
})
