import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const [directory, fromID, toID] = process.argv.slice(2)
assert.ok(
  directory && fromID && toID && fromID !== toID,
  "usage: bun test-session-first-switch.ts <directory> <from-session> <to-session>",
)
const prefix = `/${Buffer.from(directory).toString("base64url")}/session/`
const reportPath = Bun.env.OPENCODE_SESSION_SWITCH_REPORT ?? "/tmp/opencode-session-first-switch.json"

type Sample = {
  at: number
  overlay: string
  rows: number
  top: number
  height: number
  client: number
  pending: number
}
type Profile = { sessionID: string; stage: string; detail?: string }

await withCdp(async (cdp, target) => {
  assert.ok(target.url.includes("localhost:5173"), "only operate the development renderer")
  const navigate = (id: string) =>
    cdp.evaluate(`(() => {
    const href = ${JSON.stringify(prefix)} + ${JSON.stringify(id)};
    const existing = [...document.querySelectorAll('a[href]')].find(a => a.getAttribute('href') === href);
    const link = existing ?? document.createElement('a');
    if (!existing) { link.href = href; document.body.append(link); }
    link.click();
    if (!existing) link.remove();
    return true;
  })()`)
  const waitFor = async (expression: string, label: string) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        if (await cdp.evaluate(expression)) return
      } catch {
        // Reload briefly invalidates the execution context.
      }
      await Bun.sleep(50)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const sourceReady = `(() => {
    const page = document.querySelector('[data-component="session-page"]');
    return page?.dataset.sessionId === ${JSON.stringify(fromID)} && page.dataset.renderPhase === 'interactive';
  })()`
  await navigate(fromID)
  await waitFor(sourceReady, "source session before reload")
  const origin = await cdp.evaluate("performance.timeOrigin")
  await cdp.call("Page.reload")
  await waitFor(`performance.timeOrigin !== ${origin}`, "new renderer context")
  await waitFor(sourceReady, "source session after reload")
  await waitFor(
    `[...document.querySelectorAll('a[href]')].some(a => a.getAttribute('href') === ${JSON.stringify(prefix + toID)})`,
    "target sidebar entry",
  )
  // Focus uses the sidebar's real prefetch handler without mounting the target.
  await cdp.evaluate(`(() => {
    const href = ${JSON.stringify(prefix + toID)};
    const link = [...document.querySelectorAll('a[href]')].find(a => a.getAttribute('href') === href);
    if (!link) throw new Error('target must be in the sidebar');
    link.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    return true;
  })()`)
  const prefetchModule = await cdp.evaluate<string>(`(async () => {
    const source = await (await fetch(${JSON.stringify(`/@fs${resolve(import.meta.dir, "../../app/src/pages/layout.tsx")}`)})).text();
    const line = source.split('\\n').find(line => line.includes('from "') && line.includes('/session-prefetch.ts'));
    const path = line?.match(/from "([^"]+)"/)?.[1];
    if (!path) throw new Error('active prefetch module missing');
    return path;
  })()`)
  await waitFor(
    `import(${JSON.stringify(prefetchModule)}).then(module =>
    (module.getSessionPrefetch(${JSON.stringify(directory)}, ${JSON.stringify(toID)})?.count ?? 0) > 0
  )`,
    "sidebar data prefetch without target rendering",
  )
  await cdp.evaluate(`(() => {
    const id = ${JSON.stringify(toID)};
    if (document.querySelector('[data-component="message-timeline"]')?.dataset.sessionId === id)
      throw new Error('target must not mount before the first switch');
    window.__sessionSwitchFrames = [];
    window.__sessionSwitchStop = false;
    window.__opencodeSessionProfile?.clear();
    let previous;
    const start = performance.now();
    const frame = () => {
      if (window.__sessionSwitchStop) return;
      const page = document.querySelector('[data-component="session-page"]');
      if (page?.dataset.sessionId === id) {
        const timeline = page.querySelector('[data-component="message-timeline"]');
        const root = timeline?.querySelector('[data-slot="scroll-view-viewport"]');
        const box = root?.getBoundingClientRect();
        const markdown = [...(root?.querySelectorAll('[data-component="markdown"]') ?? [])].filter(node => {
          const row = node.closest('[data-timeline-key]')?.getBoundingClientRect();
          return row && box && row.bottom > box.top && row.top < box.bottom;
        });
        const sample = {
          overlay: page.querySelector('[data-slot="session-render-overlay"]')?.dataset.state ?? 'hidden',
          rows: root?.querySelectorAll('[data-timeline-key]').length ?? 0,
          top: Math.round(root?.scrollTop ?? 0), height: root?.scrollHeight ?? 0, client: root?.clientHeight ?? 0,
          pending: markdown.filter(node => node.dataset.markdownRenderedStage !== 'full').length,
        };
        const key = JSON.stringify(sample);
        if (key !== previous) window.__sessionSwitchFrames.push({ at: Math.round(performance.now() - start), ...sample });
        previous = key;
      }
      requestAnimationFrame(frame);
    };
    // Observe synchronously after the click as well as before each subsequent paint.
    window.__sessionSwitchSample = frame;
    return true;
  })()`)
  await navigate(toID)
  await cdp.evaluate("window.__sessionSwitchSample(); true")
  await waitFor(
    `document.querySelector('[data-component="session-page"]')?.dataset.renderPhase === 'interactive'`,
    "target layout settlement",
  )
  await Bun.sleep(1_000)
  const report = await cdp.evaluate<{ samples: Sample[]; profiles: Profile[] }>(`(() => {
    window.__sessionSwitchStop = true;
    return { samples: window.__sessionSwitchFrames, profiles: window.__opencodeSessionProfile?.snapshot() ?? [] };
  })()`)
  await Bun.write(reportPath, JSON.stringify(report, null, 2))
  const profiles = report.profiles.filter((event) => event.sessionID === toID)
  const route = profiles.find((event) => event.stage === "route-effect")
  assert.ok(route?.detail?.includes("cached=true"), "must exercise prefetched data, not direct cold loading")
  const visible = report.samples.filter((sample) => sample.overlay !== "showing")
  const last = visible.at(-1)
  console.log(
    `[session-switch-test] cached=true samples=${report.samples.length} visible=${visible.length} report=${reportPath}`,
  )
  assert.ok(
    report.samples.some((sample) => sample.overlay === "showing"),
    "prefetched messages still require a layout overlay",
  )
  assert.ok(last && last.rows > 0, "target messages must be visible")
  for (const sample of visible) {
    assert.ok(sample.rows > 0 && sample.pending === 0, "must not expose blank or unfinished Markdown")
    assert.ok(Math.abs(sample.height - sample.client - sample.top) <= 1, "must reveal at the bottom")
    assert.ok(
      Math.abs(sample.top - last.top) <= 1 && sample.height === last.height,
      "visible layout must not jump after reveal",
    )
  }
  console.log(`[session-switch-test] PASS first switch after reload bottomGap=${last.height - last.client - last.top}`)
})
