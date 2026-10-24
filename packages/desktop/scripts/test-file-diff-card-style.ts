import { strict as assert } from "node:assert"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (text: string) => console.log(`[file-diff-card-style-test] ${text}`)
const source = `/@fs${resolve(import.meta.dir, "../../app/src")}`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const directory = await realpath(await mkdtemp("/tmp/opencode-diff-card-style-"))
  const server = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previous = await cdp.evaluate<{ directory: string; sessionID: string } | undefined>(`(() => {
    const tab = document.querySelector('[data-component="session-tab"][data-active="true"]');
    return tab ? { directory: tab.dataset.directory, sessionID: tab.dataset.sessionId } : undefined;
  })()`)
  const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(server.url + path, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async (label: string, check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await check()) return
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const navigate = (dir: string, id: string) =>
    cdp.evaluate(`window.__diffStyleNavigation = (async () => {
      const { handleNotificationClick } = await import(${JSON.stringify(`${source}/utils/notification-click.ts`)});
      handleNotificationClick(${JSON.stringify(`/${Buffer.from(dir).toString("base64url")}/session/${id}`)});
    })()`)
  let sessionID: string | undefined
  try {
    const session = await request("/session", "POST", { title: "QA file diff card typography" })
    sessionID = session.id
    const marker = "FILE_DIFF_CARD_STYLE_SIDECAR_OK"
    await request(`/session/${sessionID}/shell`, "POST", { agent: "build", command: `printf ${marker}` })
    const messages = await request(`/session/${sessionID}/message`)
    assert.ok(messages.some((m: any) => m.info.role === "user"))
    assert.ok(
      messages.some(
        (m: any) =>
          m.info.role === "assistant" &&
          m.parts.some(
            (p: any) => p.type === "tool" && p.state.status === "completed" && p.state.output.includes(marker),
          ),
      ),
    )
    log("PASS real sidecar message sent and reply received")
    // Only the owned test session's initial snapshot gets fixture diffs; no database edits.
    await cdp.evaluate(`(() => {
      const original = window.fetch;
      window.__diffStyleOriginalFetch = original;
      window.fetch = async (...args) => {
        const response = await original(...args);
        const url = new URL(typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0]), location.href);
        if (url.pathname !== ${JSON.stringify(`/session/${sessionID}/message`)} || !response.ok) return response;
        const rows = await response.clone().json();
        const user = rows.find(row => row.info.role === 'user');
        if (!user) throw Error('test user snapshot missing');
        user.info.summary = { diffs: [
          { file: 'test-session-task-open.ts', before: '', after: '', additions: 41, deletions: 9, status: 'modified', size: 10342 },
          { file: 'added.ts', before: '', after: '', additions: 120, deletions: 0, status: 'added', size: 2048 },
          { file: 'deleted.ts', before: '', after: '', additions: 0, deletions: 91, status: 'deleted', size: 512 },
          { file: 'long-filename-for-card-truncation-and-layout-check.ts', before: '', after: '', additions: 123456, deletions: 7890, status: 'modified', size: 5 * 1024 * 1024 }
        ] };
        return new Response(JSON.stringify(rows), { status: response.status, headers: response.headers });
      };
    })()`)
    await navigate(directory, sessionID!)
    const cards = '[data-slot="session-turn-diff-card"]'
    await wait("four real timeline cards", () => cdp.evaluate(`document.querySelectorAll('${cards}').length === 4`))
    const styles = await cdp.evaluate<any[]>(`[...document.querySelectorAll('${cards}')].map(card => {
      const title = card.querySelector('[data-slot="session-turn-diff-filename"]');
      const meta = card.querySelector('[data-slot="session-turn-diff-meta"]');
      const numbers = [...meta.querySelectorAll('[data-slot="diff-changes-additions"], [data-slot="diff-changes-deletions"], [data-slot="session-turn-diff-status"], [data-slot="session-turn-diff-size"]')];
      const font = el => { const s = getComputedStyle(el); return { family: s.fontFamily, size: s.fontSize, line: s.lineHeight, weight: s.fontWeight }; };
      const style = getComputedStyle(card);
      return { title: title.textContent, titleFont: font(title), metaFont: font(meta), numbers: numbers.map(font),
        baseSize: style.getPropertyValue('--font-size-base').trim(),
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        icon: card.querySelector('[data-component="file-icon"]').getBoundingClientRect().width,
        chevron: card.lastElementChild.getBoundingClientRect().width,
        width: card.getBoundingClientRect().width, overflow: meta.scrollWidth > meta.clientWidth };
    })`)
    for (const card of styles) {
      const expectedSize = `${parseFloat(card.baseSize) - 2}px`
      assert.equal(card.titleFont.size, expectedSize)
      assert.equal(card.metaFont.size, expectedSize)
      assert.ok(/mono|code|consolas/i.test(card.metaFont.family), card.metaFont.family)
      for (const number of card.numbers) assert.deepEqual(number, card.metaFont)
      assert.deepEqual(card.padding, ["12px", "15px", "12px", "15px"])
      assert.equal(card.icon, 32)
      assert.equal(card.chevron, 20)
      assert.ok(card.width <= 360)
      assert.equal(card.overflow, false, card.title)
      log(`PASS typography, padding and icons: ${card.title}`)
    }
    const screenshot = await cdp.call<{ data: string }>("Page.captureScreenshot")
    await Bun.write("/tmp/opencode-file-diff-cards.png", Buffer.from(screenshot.data, "base64"))
  } finally {
    await cdp.evaluate(`(() => {
      if (!window.__diffStyleOriginalFetch) return;
      window.fetch = window.__diffStyleOriginalFetch;
      delete window.__diffStyleOriginalFetch;
    })()`)
    if (sessionID) await request(`/session/${sessionID}`, "DELETE")
    if (previous?.directory && previous.sessionID) await navigate(previous.directory, previous.sessionID)
    await rm(directory, { recursive: true, force: true })
    log("test data cleaned; original fetch and session restored")
  }
})
