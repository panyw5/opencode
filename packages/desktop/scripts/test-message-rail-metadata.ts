import { strict as assert } from "node:assert"
import { withCdp } from "./cdp"

const [directory, sessionID, messageID, mode] = process.argv.slice(2)
assert.ok(
  directory && sessionID && messageID,
  "usage: test-message-rail-metadata.ts <directory> <session> <message> [--expect-failure]",
)
const route = `/${Buffer.from(directory).toString("base64url")}/session/${sessionID}`
const selector = `[data-testid="session-user-message-rail-item"][data-message-id="${messageID}"]`

await withCdp(async (cdp, target) => {
  assert.ok(target.url.includes("localhost:5173"), "development renderer only")
  await cdp.call("Page.enable")
  const wait = async (expression: string) => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await cdp.evaluate(expression)) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${expression}`)
  }
  // Reproduce a metadata-only SSE cache entry without changing the user's DB.
  const { identifier } = await cdp.call<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      window.__railRegression = { logs: [], injected: false };
      const debug = console.debug.bind(console);
      console.debug = (...args) => {
        window.__railRegression.logs.push(args.map(String).join(' '));
        debug(...args);
      };
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname !== ${JSON.stringify(`/session/${sessionID}/message`)} ||
            url.searchParams.has('before') || window.__railRegression.injected) return original(request);
        window.__railRegression.injected = true;
        url.searchParams.set('limit', '80');
        const response = await original(new Request(url, request));
        const rows = await response.json();
        url.pathname += '/' + ${JSON.stringify(messageID)};
        url.searchParams.delete('limit');
        const message = await (await original(new Request(url, request))).json();
        window.__railRegression.expectedText = message.parts.find(p => p.type === 'text' && !p.synthetic)?.text;
        rows.push({ info: message.info, parts: [] });
        console.debug('[rail-regression] injected metadata-only message=' + message.info.id);
        return new Response(JSON.stringify(rows), { status: response.status, headers: response.headers });
      };
    })()`,
  })
  try {
    await cdp.call("Page.reload")
    await wait(
      "!!window.__railRegression && document.readyState === 'complete' && !!document.querySelector('[data-component=session-page]')",
    )
    await cdp.evaluate(`(() => {
      const a = document.createElement('a'); a.href = ${JSON.stringify(route)};
      document.body.append(a); a.click(); a.remove();
    })()`)
    await wait(`window.__railRegression.injected && !!document.querySelector(${JSON.stringify(selector)})`)
    await wait(
      `document.querySelector('[data-component="session-page"][data-session-id="${sessionID}"]')?.dataset.renderPhase === 'interactive'`,
    )
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await Bun.sleep(4_000)
    const result = await cdp.evaluate<{
      failed: boolean
      top: number
      visible: boolean
      text: boolean
      logs: string[]
    }>(`(() => {
      const root = document.querySelector('[data-component=message-timeline] [data-slot=scroll-view-viewport]');
      const row = document.querySelector('[data-timeline-key="user-message:${messageID}"]');
      const box = row?.getBoundingClientRect();
      const viewport = root?.getBoundingClientRect();
      return {
        failed: window.__railRegression.logs.some(line => line.includes('stage=unavailable')),
        top: root?.scrollTop,
        visible: !!box && box.bottom > viewport.top && box.top < viewport.bottom,
        text: !!row && row.textContent.includes(window.__railRegression.expectedText?.slice(0, 60)),
        logs: window.__railRegression.logs.filter(line => /rail-regression|jump|parent-recovery|message-position/.test(line))
      };
    })()`)
    console.log(JSON.stringify(result, null, 2))
    if (mode === "--expect-failure") assert.ok(result.failed && !result.visible, "must reproduce the original failure")
    else
      assert.ok(
        !result.failed && result.visible && result.text && result.top <= 2,
        "first message must be visible with its content and no timeout",
      )
  } finally {
    await cdp.call("Page.removeScriptToEvaluateOnNewDocument", { identifier })
    await cdp.call("Page.reload")
  }
})
