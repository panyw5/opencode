import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const [directory, sourceID, targetID] = process.argv.slice(2)
assert.ok(
  directory && sourceID && targetID && sourceID !== targetID,
  "usage: bun test-session-cache-recovery.ts <directory> <source-session> <target-session>",
)
const prefix = `/${Buffer.from(directory).toString("base64url")}/session/`
let rowModule = ""
let htmlModule = ""
type Frame = {
  overlay: string
  top: number
  height: number
  client: number
  rows: number
  pending: number
  corrupt: boolean
}
const report: Array<{ name: string; frames: Frame[] }> = []

await withCdp(async (cdp) => {
  const navigate = (id: string) =>
    cdp.evaluate(`(() => {
    const a = document.createElement('a'); a.href = ${JSON.stringify(prefix)} + ${JSON.stringify(id)};
    document.body.append(a); a.click(); a.remove(); return true;
  })()`)
  const ready = async (id: string) => {
    const until = Date.now() + 15_000
    while (Date.now() < until) {
      if (
        await cdp.evaluate(`(() => {
        const page = document.querySelector('[data-component="session-page"]');
        return page?.dataset.sessionId === ${JSON.stringify(id)} && page.dataset.renderPhase === 'interactive'
          && !page.querySelector('[data-slot="session-render-overlay"]');
      })()`)
      )
        return
      await Bun.sleep(20)
    }
    throw new Error(`Session not ready ${id}`)
  }
  const captureIdentity = () =>
    cdp.evaluate<{ key: string; part: string }>(`(() => {
    const root = document.querySelector('[data-component="message-timeline"] [data-slot="scroll-view-viewport"]');
    const box = root.getBoundingClientRect();
    const text = [...root.querySelectorAll('[data-component="text-part"]')].find(node => {
      const row = node.closest('[data-timeline-key]').getBoundingClientRect();
      return row.bottom > box.top && row.top < box.bottom;
    });
    if (!text) throw new Error('fixture needs a visible completed text reply');
    return { key: text.closest('[data-timeline-key]').dataset.timelineKey, part: text.dataset.partId };
  })()`)
  const observeReturn = async (name: string, loading: boolean) => {
    await cdp.evaluate(`(() => {
      window.__cacheRecoveryFrames = []; window.__cacheRecoveryStop = false;
      let previous;
      const frame = () => {
        if (window.__cacheRecoveryStop) return;
        const page = document.querySelector('[data-component="session-page"]');
        if (page?.dataset.sessionId === ${JSON.stringify(targetID)}) {
          const root = page.querySelector('[data-component="message-timeline"] [data-slot="scroll-view-viewport"]');
          const box = root?.getBoundingClientRect();
          const markdown = [...(root?.querySelectorAll('[data-component="markdown"]') ?? [])].filter(node => {
            const row = node.closest('[data-timeline-key]')?.getBoundingClientRect();
            return row && box && row.bottom > box.top && row.top < box.bottom;
          });
          const sample = { overlay: page.querySelector('[data-slot="session-render-overlay"]')?.dataset.state ?? 'hidden',
            top: Math.round(root?.scrollTop ?? 0), height: root?.scrollHeight ?? 0, client: root?.clientHeight ?? 0,
            rows: root?.querySelectorAll('[data-timeline-key]').length ?? 0,
            pending: markdown.filter(node => node.dataset.markdownRenderedStage !== 'full' || node.dataset.markdownFallback === 'true').length,
            corrupt: page.textContent.includes('CORRUPT_HTML_CACHE_SENTINEL') };
          const key = JSON.stringify(sample);
          if (key !== previous) window.__cacheRecoveryFrames.push(sample);
          previous = key;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame); return true;
    })()`)
    await navigate(targetID)
    await ready(targetID)
    // Resolve Vite's active HMR URLs. Importing an unversioned path can create
    // a different module instance and would not exercise the renderer's cache.
    const modules = await cdp.evaluate<{ row: string; html: string }>(`(async () => {
      const dependency = async (parent, name) => {
        const source = await (await fetch(parent)).text();
        const line = source.split('\\n').find(line => line.includes('from "') && line.includes('/' + name));
        const path = line?.match(/from "([^"]+)"/)?.[1];
        if (!path) throw new Error('active cache module not found: ' + name);
        return path;
      };
      return {
        row: await dependency(${JSON.stringify(`/@fs${resolve(import.meta.dir, "../../app/src/pages/session/timeline/message-timeline.tsx")}`)}, 'row-cache.ts'),
        html: await dependency(${JSON.stringify(`/@fs${resolve(import.meta.dir, "../../ui/src/components/markdown.tsx")}`)}, 'markdown-cache.ts'),
      };
    })()`)
    rowModule = modules.row
    htmlModule = modules.html
    await Bun.sleep(100)
    const frames = await cdp.evaluate<Frame[]>("window.__cacheRecoveryStop = true; window.__cacheRecoveryFrames")
    report.push({ name, frames })
    await Bun.write("/tmp/opencode-session-cache-recovery.json", JSON.stringify(report, null, 2))
    assert.ok(frames.length > 0, `${name}: no observed frames`)
    if (loading)
      assert.ok(
        frames.some((frame) => frame.overlay === "showing"),
        `${name}: corrupt cache must stay covered`,
      )
    else
      assert.ok(
        frames.every((frame) => frame.overlay === "hidden"),
        `${name}: valid cache must not show loading`,
      )
    for (const frame of frames) {
      assert.equal(frame.corrupt, false, `${name}: corrupt HTML reached the DOM`)
      if (frame.overlay === "showing") continue
      assert.ok(frame.rows > 0 && frame.pending === 0, `${name}: exposed incomplete rendering`)
      assert.ok(Math.abs(frame.height - frame.client - frame.top) <= 1, `${name}: exposed the wrong bottom position`)
    }
    console.log(`[cache-recovery] PASS name=${name} loading=${loading}`)
  }

  try {
    await navigate(targetID)
    await ready(targetID)
    let identity = await captureIdentity()
    await navigate(sourceID)
    await ready(sourceID)
    await observeReturn("valid-warm-cache", false)
    for (const [name, patch] of [
      ["height-mismatch", "height: entry.height + 300"],
      ["height-NaN", "height: NaN"],
      ["height-Infinity", "height: Infinity"],
      ["height-negative", "height: -1"],
      ["width-stale", "width: entry.width + 300"],
      ["content-version-stale", "contentVersion: 'CORRUPT_VERSION'"],
      ["timestamp-invalid", "measuredAt: Infinity"],
    ]) {
      identity = await captureIdentity()
      await navigate(sourceID)
      await ready(sourceID)
      await cdp.evaluate(`(async () => {
        const { timelineRowCache: cache } = await import(${JSON.stringify(rowModule)});
        const key = ${JSON.stringify(identity.key)}; const entry = cache.get(key);
        if (!entry) throw new Error('missing warmed measurement');
        // Deliberately bypass validation to simulate damaged in-memory cache storage.
        cache.rows.set(key, { ...entry, ${patch} }); return true;
      })()`)
      await observeReturn(name, true)
      const repaired = await cdp.evaluate<boolean>(`(async () => {
        const { timelineRowCache: cache } = await import(${JSON.stringify(rowModule)});
        const key = ${JSON.stringify(identity.key)}; const entry = cache.get(key);
        const row = [...document.querySelectorAll('[data-component="message-timeline"] [data-timeline-key]')].find(node => node.dataset.timelineKey === key);
        return !!entry && !!row && Number.isFinite(entry.height) && Math.abs(entry.height - row.firstElementChild.offsetHeight) <= 1;
      })()`)
      assert.ok(repaired, `${name}: damaged measurement was not repaired`)
      await navigate(sourceID)
      await ready(sourceID)
      await observeReturn(`${name}-repaired-warm-cache`, false)
    }
    identity = await captureIdentity()
    await navigate(sourceID)
    await ready(sourceID)
    await cdp.evaluate(`(async () => {
      const { markdownHtmlCache: cache } = await import(${JSON.stringify(htmlModule)});
      const item = [...cache.entries].find(([key]) => key.includes(':full:') && key.endsWith(':' + ${JSON.stringify(identity.part)}));
      if (!item) throw new Error('missing warmed HTML cache');
      cache.entries.set(item[0], { ...item[1], html: 'CORRUPT_HTML_CACHE_SENTINEL' }); return true;
    })()`)
    await observeReturn("corrupt-HTML", true)
    await navigate(sourceID)
    await ready(sourceID)
    await observeReturn("repaired-HTML-warm-cache", false)
  } finally {
    await cdp.evaluate("window.__cacheRecoveryStop = true; true").catch(() => {})
  }
})
