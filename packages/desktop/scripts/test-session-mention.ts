import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"

const log = (message: string) => console.log(`[session-mention-test] ${message}`)
const app = `/@fs${resolve(import.meta.dir, "../../app/src")}`
const directory = resolve(import.meta.dir, "../../..")
const editor = '[data-component="prompt-input"][role="textbox"]'
const capsule = `${editor} [data-type="session"]`

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previous = await cdp.evaluate<{ directory: string; sessionID: string }>(`(() => {
    const tab = document.querySelector('[data-component="session-tab"][data-active="true"]');
    return { directory: tab?.dataset.directory, sessionID: tab?.dataset.sessionId };
  })()`)
  const keybinds = await cdp.evaluate(
    `window.api.storeGet("default.dat", "settings.v3").then(v => JSON.parse(v || "{}").keybinds)`,
  )
  log(`effective keybind overrides=${JSON.stringify(keybinds)}`)
  const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${response.ok ? "" : await response.text()}`)
    return response.status === 204 ? undefined : response.json()
  }
  const wait = async <T>(label: string, predicate: () => Promise<T>, timeout = 30_000): Promise<NonNullable<T>> => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await predicate()
      if (value) return value as NonNullable<T>
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const exists = (selector: string) => cdp.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
  const click = (selector: string) => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const navigate = (dir: string, id: string) =>
    cdp.evaluate(`window.__sessionMentionNavigation = (async () => {
    const { handleNotificationClick } = await import(${JSON.stringify(`${app}/utils/notification-click.ts`)});
    handleNotificationClick(${JSON.stringify(`/${Buffer.from(dir).toString("base64url")}/session/${id}`)});
  })()`)
  const key = async (key: string, modifiers = 0) => {
    const windowsVirtualKeyCode = ({ Backspace: 8, ArrowUp: 38, z: 90 } as Record<string, number>)[key]
    const code = key === "z" ? "KeyZ" : key
    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, windowsVirtualKeyCode })
    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, windowsVirtualKeyCode })
  }
  const clear = () =>
    cdp.evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(editor)}); e.focus();
    const r = document.createRange(); r.selectNodeContents(e);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand("delete");
  })()`)
  let sourceID: string | undefined
  let targetID: string | undefined
  const marker = `SESSION_REF_QA_${Date.now()}`
  try {
    const source = await request("/session", "POST", { title: "QA @ session reference source" })
    sourceID = source.id
    log(`source created session=${sourceID}`)
    await request(`/session/${sourceID}/message`, "POST", {
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: `The verification token for this conversation is ${marker}.` }],
    })
    log("source token message stored")
    const destination = await request("/session", "POST", { title: "QA @ session reference target" })
    targetID = destination.id
    log(`target created session=${targetID}`)
    await navigate(directory, targetID!)
    log("target navigation dispatched")
    await wait("target active", () =>
      exists(`[data-component="session-tab"][data-active="true"][data-session-id="${targetID}"]`),
    )
    await wait("empty editor", () =>
      cdp.evaluate(`document.querySelector(${JSON.stringify(editor)})?.textContent === ""`),
    )
    await cdp.evaluate(`document.querySelector(${JSON.stringify(editor)}).focus()`)
    await cdp.call("Input.insertText", { text: "@" })
    await wait("source option", () =>
      cdp.evaluate(
        `!![...document.querySelectorAll('[data-component="prompt-popover"] button')].find(e => e.textContent.includes(${JSON.stringify(sourceID)}))`,
      ),
    )
    await cdp.evaluate(`(() => {
      const original = window.fetch;
      window.__sessionMentionFetchOriginal = original;
      window.fetch = async (...args) => {
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        if (url.includes(${JSON.stringify(`/session/${sourceID}/message?limit=10`)})) {
          window.__sessionMentionWaiting = true;
          await new Promise(resolve => { window.__sessionMentionRelease = resolve; });
        }
        return original(...args);
      };
    })()`)
    await cdp.evaluate(
      `[...document.querySelectorAll('[data-component="prompt-popover"] button')].find(e => e.textContent.includes(${JSON.stringify(sourceID)})).click()`,
    )
    await wait("snapshot fetch gated", () => cdp.evaluate("window.__sessionMentionWaiting"))
    await cdp.call("Input.insertText", { text: " while loading" })
    await cdp.evaluate("window.fetch = window.__sessionMentionFetchOriginal; window.__sessionMentionRelease()")
    await wait("inline capsule", () => exists(capsule))
    assert.ok(
      await cdp.evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent.includes(" while loading")`),
    )
    const snapshot = await cdp.evaluate<any>(
      `JSON.parse(document.querySelector(${JSON.stringify(capsule)}).dataset.reference)`,
    )
    assert.equal(snapshot.sessionID, sourceID)
    assert.ok(snapshot.summary.includes(marker))
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(capsule)}).contentEditable`), "false")
    const card = `[data-component="session-reference"][data-session-id="${sourceID}"]`
    await wait("@ reference card", () => exists(card))
    assert.ok(
      await cdp.evaluate(
        `document.querySelector(${JSON.stringify(card)}).textContent.includes(${JSON.stringify(marker)})`,
      ),
    )
    assert.equal(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(card)}).length`), 1)
    const cardContent = await cdp.evaluate<{ text: string; rows: number }>(`(() => {
      const e = document.querySelector(${JSON.stringify(card)});
      return { text: e.textContent, rows: e.children.length };
    })()`)
    assert.ok(!cardContent.text.includes(sourceID!), "card must not display the session ID")
    assert.equal(cardContent.rows, 3, "card contains only title, project and excerpt; no snapshot time row")
    log("PASS card omits the session ID and snapshot timestamp row")
    await click(`${card} button`)
    await wait("card close removes capsule and card", async () => !(await exists(card)) && !(await exists(capsule)))
    await cdp.evaluate(`document.querySelector(${JSON.stringify(editor)}).focus()`)
    await key("z", 4)
    await wait("undo card close restores capsule and card", async () => (await exists(card)) && (await exists(capsule)))
    log("PASS @ reference shows the snapshot card, closing it removes the capsule, and undo restores both")
    log("PASS @ selection loads the real sidecar snapshot, inserts a capsule, and preserves typing during loading")
    await Bun.sleep(100)
    await cdp.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(editor)}), p = e.querySelector('[data-type="session"]');
      e.focus();
      const r = document.createRange(); r.selectNode(p); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`)
    await key("Backspace")
    await wait("capsule deleted", async () => !(await exists(capsule)))
    await wait("capsule deletion removes card", async () => !(await exists(card)))
    await key("z", 4)
    await wait("capsule undo", () => exists(capsule))
    await key("z", 12)
    await wait("capsule redo", async () => !(await exists(capsule)))
    await key("z", 4)
    await wait("capsule restored", () => exists(capsule))
    await wait("capsule undo restores card", () => exists(card))
    log("PASS deletion, undo and redo preserve the capsule snapshot")

    await cdp.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(editor)}); e.focus();
      const r = document.createRange(); r.selectNodeContents(e); r.collapse(false);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`)
    await cdp.call("Input.insertText", {
      text: " Reply only with the verification token in the attached session excerpt. Do not use tools.",
    })
    await wait("draft persisted through IPC", () =>
      cdp.evaluate(`window.__sessionMentionPersistence = (async () => {
      const { PersistTesting } = await import(${JSON.stringify(`${app}/utils/persist.ts`)});
      const value = JSON.parse(await window.api.storeGet(PersistTesting.workspaceStorage(${JSON.stringify(directory)}), ${JSON.stringify(`session:${targetID}:prompt`)}) || "{}");
      return value.prompt?.some(p => p.type === "session" && p.reference.sessionID === ${JSON.stringify(sourceID)}) && value.prompt?.some(p => p.type === "text" && p.content.includes("Do not use tools"));
    })()`),
    )
    await cdp.evaluate("window.__sessionMentionBeforeReload = true")
    await cdp.call("Page.reload")
    await wait("new document loaded", () =>
      cdp.evaluate("!window.__sessionMentionBeforeReload && document.readyState === 'complete'"),
    )
    await wait("capsule persists after reload", () => exists(capsule))
    await wait("@ card persists after reload", () => exists(card))
    assert.equal(
      await cdp.evaluate(`JSON.parse(document.querySelector(${JSON.stringify(capsule)}).dataset.reference).sessionID`),
      sourceID,
    )
    await click('[data-action="prompt-session-history"]')
    await wait("quote option", () =>
      cdp.evaluate(
        `!![...document.querySelectorAll('button')].find(e => e.title?.includes(${JSON.stringify(sourceID)}))`,
      ),
    )
    await cdp.evaluate(
      `[...document.querySelectorAll('button')].find(e => e.title?.includes(${JSON.stringify(sourceID)})).click()`,
    )
    await wait("quote context", () => exists('[data-component="session-reference"]'))
    await wait("quote menu closed", () =>
      cdp.evaluate(
        `![...document.querySelectorAll('button')].some(e => e.title?.includes(${JSON.stringify(sourceID)}))`,
      ),
    )
    log("PASS persisted capsule survives reload and coexists with the quote-button reference")
    assert.equal(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(card)}).length`), 1)

    const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-session-mention.png", Buffer.from(shot.data, "base64"))
    await cdp.call("Emulation.setDeviceMetricsOverride", {
      width: 560,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    const geometry = await cdp.evaluate<{ pill: number; editor: number }>(`(() => ({
      pill: document.querySelector(${JSON.stringify(capsule)}).getBoundingClientRect().width,
      editor: document.querySelector(${JSON.stringify(editor)}).getBoundingClientRect().width,
    }))()`)
    assert.ok(geometry.pill <= geometry.editor, "capsule must fit in a narrow composer")
    const narrow = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-session-mention-narrow.png", Buffer.from(narrow.data, "base64"))
    await cdp.call("Emulation.clearDeviceMetricsOverride")
    log("PASS capsule fits a narrow window")
    await click('[data-action="prompt-submit"]')
    const received = await wait("stored reference snapshot", async () => {
      const messages = await request(`/session/${targetID}/message`)
      const user = messages.find((m: any) => m.info.role === "user")
      return user?.parts.some((p: any) => p.metadata?.sessionReference?.sessionID === sourceID) ? user : undefined
    })
    const references = received.parts.filter((p: any) => p.metadata?.sessionReference)
    assert.equal(references.length, 1)
    assert.ok(references[0].text.includes(marker))
    assert.equal(references[0].metadata.sessionReferenceSources.length, 1)
    log(`PASS renderer sent one deduplicated snapshot to sidecar session=${targetID}`)
    const reply = await wait(
      "model reply containing source-only token",
      async () => {
        const messages = await request(`/session/${targetID}/message`)
        return messages.find(
          (m: any) =>
            m.info.role === "assistant" &&
            m.info.time.completed &&
            m.parts.some((p: any) => p.type === "text" && p.text.includes(marker)),
        )
      },
      120_000,
    )
    assert.ok(reply)
    await wait("sent reference card", () => exists('[data-component="sent-session-reference"]'))
    const sentCard = await cdp.evaluate<{ text: string; meta: number }>(`(() => {
      const e = document.querySelector('[data-component="sent-session-reference"]');
      return { text: e.textContent, meta: e.querySelectorAll('[data-slot="session-reference-meta"]').length };
    })()`)
    assert.ok(!sentCard.text.includes(sourceID!), "sent card must not display the session ID")
    assert.equal(sentCard.meta, 1, "sent card retains only the project metadata row")
    log(`PASS real model received quoted context and replied with ${marker}`)
    await wait("editor cleared after send", () =>
      cdp.evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent === ""`),
    )
    await cdp.evaluate(`document.querySelector(${JSON.stringify(editor)}).focus()`)
    await key("ArrowUp")
    await wait("history restores capsule", () => exists(capsule))
    await wait("history restores @ card", () => exists(card))
    assert.ok(
      await cdp.evaluate(
        `JSON.parse(document.querySelector(${JSON.stringify(capsule)}).dataset.reference).summary.includes(${JSON.stringify(marker)})`,
      ),
    )
    await clear()
    log("PASS prompt history restores the inline capsule with its snapshot")
  } finally {
    await cdp
      .evaluate(
        `(() => {
      if (window.__sessionMentionFetchOriginal) window.fetch = window.__sessionMentionFetchOriginal;
      window.__sessionMentionRelease?.();
    })()`,
      )
      .catch(() => {})
    await cdp.call("Emulation.clearDeviceMetricsOverride").catch(() => {})
    for (const id of [targetID, sourceID].filter(Boolean)) {
      await cdp.evaluate(
        `document.querySelector('[data-component="session-tab"][data-session-id="${id}"] [data-action="session-tab-close"]')?.click()`,
      )
      await request(`/session/${id}/abort`, "POST").catch(() => {})
      await request(`/session/${id}`, "DELETE")
    }
    if (previous.directory && previous.sessionID) await navigate(previous.directory, previous.sessionID)
    log("test sessions cleaned and previous session restored")
  }
})
