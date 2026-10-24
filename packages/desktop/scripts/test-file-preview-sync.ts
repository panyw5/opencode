import { strict as assert } from "node:assert"
import { mkdir, rename, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

// Run in a blank draft for this repository in the dev Electron renderer.
const directory = resolve(import.meta.dir, "../../..")
const id = Date.now()
const relative = `node_modules/.cache/preview-sync-${id}/image.svg`
const hidden = relative.replace("image.svg", "hidden.svg")
const file = resolve(directory, relative)
const hiddenFile = resolve(directory, hidden)
const flood = resolve(directory, `.preview-sync-flood-${id}`)
const svg = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="${color}"/></svg>`
await mkdir(resolve(file, ".."), { recursive: true })
await Bun.write(file, svg("red"))
await Bun.write(hiddenFile, svg("red"))

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const wait = async (condition: () => Promise<boolean>, reason: string, timeout = 15_000) => {
    const deadline = Date.now() + timeout
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${reason}`)
      await Bun.sleep(100)
    }
  }
  const open = (path: string) =>
    cdp.evaluate(
      `window.dispatchEvent(new CustomEvent('opencode:presentation-source', { detail: { path: ${JSON.stringify(path)} } }))`,
    )
  const logs = () => cdp.evaluate<string[]>("window.__previewSyncLogs ?? []")
  const reads = async (path = relative) =>
    (await logs()).filter((line) => line.includes("[file-content] load-start") && line.includes(`file=${path} `)).length
  const source = () =>
    cdp.evaluate<string | null>(`(() => {
    const button = document.querySelector('[data-action="file-preview-refresh"]');
    const image = [...(button?.closest('[role="tabpanel"]')?.querySelectorAll('img') ?? [])].find(el => el.getAttribute('alt') === ${JSON.stringify(relative)});
    const src = image?.getAttribute('src');
    if (!src) return null;
    const data = src.slice(src.indexOf(',') + 1);
    return src.includes(';base64,') ? atob(data) : decodeURIComponent(data);
  })()`)
  const expectColor = (color: string) =>
    wait(async () => (await source())?.includes(`fill="${color}"`) ?? false, `render ${color}`)
  const online = () =>
    cdp.call("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    })
  try {
    await cdp.evaluate(`(() => {
      window.__previewSyncLogs = [];
      window.__previewSyncDebug = console.debug;
      console.debug = (...args) => {
        const line = args.map(String).join(' ');
        if (line.startsWith('[file-preview]') || line.startsWith('[file-content]')) window.__previewSyncLogs.push(line);
        window.__previewSyncDebug(...args);
      };
    })()`)
    await open(hidden)
    await wait(async () => (await reads(hidden)) > 0, "hidden file initially loaded")
    await open(relative)
    await expectColor("red")
    await Bun.sleep(800)
    const hiddenReads = await reads(hidden)
    await Bun.write(hiddenFile, svg("cyan"))
    await Bun.write(file, svg("blue"))
    await expectColor("blue")
    assert.equal(await reads(hidden), hiddenReads)
    console.log("[preview-sync-test] PASS native update in ignored directory; hidden sibling not read")

    await Bun.write(`${file}.tmp`, svg("green"))
    await rename(`${file}.tmp`, file)
    await expectColor("green")
    await rm(file)
    await wait(async () => (await source()) === null, "deleted preview cleared")
    await Bun.write(file, svg("gold"))
    await expectColor("gold")
    console.log("[preview-sync-test] PASS atomic replacement, delete, recreate")

    await cdp.evaluate(
      `Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'))`,
    )
    await Bun.sleep(300)
    const hiddenBefore = await reads()
    await Bun.write(file, svg("black"))
    await Bun.sleep(500)
    assert.equal(await reads(), hiddenBefore)
    await cdp.evaluate(
      `Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))`,
    )
    await expectColor("black")
    assert.equal(await reads(hidden), hiddenReads)
    console.log("[preview-sync-test] PASS foreground reconciliation only reads visible preview")

    await cdp.call("Network.enable")
    await cdp.call("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    })
    await Bun.sleep(1500)
    await Bun.write(file, svg("coral"))
    await Bun.sleep(300)
    await online()
    await cdp.evaluate("window.dispatchEvent(new Event('online'))")
    await expectColor("coral")
    console.log("[preview-sync-test] PASS reconnect catches missed file change")

    await mkdir(flood, { recursive: true })
    await Promise.all(Array.from({ length: 5000 }, (_, i) => Bun.write(`${flood}/${i}.txt`, "flood")))
    await wait(async () => (await logs()).some((line) => line.includes("scope invalidated")), "flood invalidation")
    assert.equal(await reads(hidden), hiddenReads)
    console.log("[preview-sync-test] PASS real filesystem storm invalidates scope without waking hidden preview")
    await rm(flood, { recursive: true, force: true })
    await Bun.sleep(1000)

    const beforeIdle = await reads()
    console.log("[preview-sync-test] waiting 127s: preview remains visible while heavy runtime becomes idle")
    await Bun.sleep(127_000)
    assert.equal(await reads(), beforeIdle, "No periodic content reads while idle")
    await Bun.write(file, svg("navy"))
    await expectColor("navy")
    console.log("[preview-sync-test] PASS visible watch survives idle disposal; no periodic reads")

    const sidecar = await cdp.evaluate<{ sent: boolean; received: boolean }>(`(async () => {
      const server = await window.api.awaitInitialization();
      const headers = { 'Content-Type': 'application/json', 'x-opencode-directory': encodeURIComponent(${JSON.stringify(directory)}), Authorization: 'Basic ' + btoa((server.username || 'opencode') + ':' + server.password) };
      const request = async (path, method = 'GET', body) => {
        const response = await fetch(server.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!response.ok) throw Error('sidecar ' + response.status + ' ' + path);
        return response.status === 204 ? null : response.json();
      };
      const session = await request('/session', 'POST', { title: 'File preview synchronization regression' });
      try {
        await request('/session/' + session.id + '/shell', 'POST', { agent: 'build', command: 'printf PREVIEW_SYNC_SIDECAR_OK' });
        const messages = await request('/session/' + session.id + '/message');
        return { sent: messages.some(m => m.info.role === 'user'), received: messages.some(m => m.info.role === 'assistant' && m.parts.some(p => p.type === 'tool' && p.state.status === 'completed' && p.state.output.includes('PREVIEW_SYNC_SIDECAR_OK'))) };
      } finally { await request('/session/' + session.id, 'PATCH', { time: { archived: Date.now() } }); }
    })()`)
    assert.equal(sidecar.sent, true)
    assert.equal(sidecar.received, true)
    console.log("[preview-sync-test] PASS sidecar shell message sent and received")
  } finally {
    await online()
    await cdp.call("Network.disable")
    await cdp.evaluate(`(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      for (const path of ${JSON.stringify([relative, hidden])}) {
        const tab = [...document.querySelectorAll('[data-slot="tabs-trigger-wrapper"]')].find(el => el.getAttribute('data-value') === 'file://' + path);
        tab?.querySelector('[data-slot="tabs-trigger-close-button"] button')?.click();
      }
      if (window.__previewSyncDebug) console.debug = window.__previewSyncDebug;
      delete window.__previewSyncDebug;
      delete window.__previewSyncLogs;
    })()`)
  }
}).finally(async () => {
  await rm(resolve(file, ".."), { recursive: true, force: true })
  await rm(flood, { recursive: true, force: true })
})
