import { strict as assert } from "node:assert"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

// Run with a blank draft open in this repository in the dev Electron app.
// Visible leaf watches must work even in directories ignored by the project watcher.
const directory = resolve(import.meta.dir, "../../..")
const relative = `node_modules/.cache/preview-refresh-${Date.now()}.svg`
const fixture = resolve(directory, relative)
const svg = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="${color}"/></svg>`

await mkdir(resolve(directory, "node_modules/.cache"), { recursive: true })
await Bun.write(fixture, svg("red"))
await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const inspect = () =>
    cdp.evaluate<{ source?: string; disabled?: boolean; logs: string[] }>(`(() => {
    const button = document.querySelector('[data-action="file-preview-refresh"]');
    const panel = button?.closest('[role="tabpanel"]');
    const image = [...(panel?.querySelectorAll('img') ?? [])].find(el => el.getAttribute('alt') === ${JSON.stringify(relative)});
    return { source: image?.getAttribute('src'), disabled: button?.disabled, logs: window.__previewRefreshLogs ?? [] };
  })()`)
  const waitFor = async (color: string) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await inspect()
      if (state.source && !state.disabled) {
        const body = state.source.split(",").slice(1).join(",")
        const text = state.source.includes(";base64,") ? atob(body) : decodeURIComponent(body)
        if (text.includes(`fill="${color}"`)) return state
      }
      await Bun.sleep(100)
    }
    throw new Error(`Preview did not render ${color}: ${JSON.stringify(await inspect())}`)
  }
  try {
    await cdp.evaluate(`(() => {
      window.__previewRefreshLogs = [];
      window.__previewRefreshDebug = console.debug;
      console.debug = (...args) => {
        window.__previewRefreshLogs.push(args.map(String).join(' '));
        window.__previewRefreshDebug(...args);
      };
      window.dispatchEvent(new CustomEvent('opencode:presentation-source', { detail: { path: ${JSON.stringify(relative)} } }));
    })()`)
    await waitFor("red")
    console.log("[preview-refresh-test] initial SVG received from sidecar")
    await Bun.write(fixture, svg("blue"))
    await Bun.sleep(600)
    await waitFor("blue")
    await Bun.sleep(500)
    const current = await inspect()
    const reads = current.logs.filter(
      (line) => line.includes("[file-content] load-start") && line.includes(relative),
    ).length
    await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-action="file-preview-refresh"]');
      const actions = button.closest('[data-slot="file-markdown-actions"]');
      actions?.querySelector('button[data-icon="dot-grid"]')?.click();
    })()`)
    const rect = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const button = document.querySelector('[data-action="file-preview-refresh"]');
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", ...rect })
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...rect })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...rect })
    const fresh = await waitFor("blue")
    assert.equal(
      fresh.logs.filter((line) => line.includes("[file-content] load-start") && line.includes(relative)).length,
      reads + 1,
    )
    assert.ok(
      fresh.logs.some((line) => line.includes("[file-preview] refresh complete") && line.includes("loaded=true")),
    )
    console.log(
      "[preview-refresh-test] PASS automatic SVG update and real manual refresh; exactly one additional sidecar read",
    )
    await cdp.evaluate(
      `document.querySelector('[data-slot="file-markdown-actions"] button[data-icon="dot-grid"]')?.click()`,
    )
    const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-preview-refresh.png", Buffer.from(screenshot.data, "base64"))
  } finally {
    await cdp.evaluate(`(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find(el => el.textContent.includes(${JSON.stringify(relative.split("/").at(-1))}));
      tab?.closest('[data-slot="tabs-trigger-wrapper"]')?.querySelector('[data-slot="tabs-trigger-close-button"] button')?.click();
      if (window.__previewRefreshDebug) console.debug = window.__previewRefreshDebug;
      delete window.__previewRefreshDebug;
      delete window.__previewRefreshLogs;
    })()`)
  }
}).finally(() => rm(fixture, { force: true }))
