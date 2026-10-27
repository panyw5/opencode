import { strict as assert } from "node:assert"
import { resolve } from "node:path"
import { withCdp } from "./cdp"
import { readSessionReferenceClipboard } from "../../app/src/components/prompt-input/session-reference-clipboard"

const directory = resolve(import.meta.dir, "../../..")
const app = `/@fs${resolve(import.meta.dir, "../../app/src")}`
const editor = '[data-component="prompt-input"][role="textbox"]'
const log = (text: string) => console.log(`[session-reference-clipboard-test] ${text}`)

await withCdp(async (cdp, target) => {
  assert.match(target.url, /^http:\/\/localhost:5173\//)
  const connection = await cdp.evaluate<{ url: string; username: string; password: string }>(
    "window.api.awaitInitialization(() => {})",
  )
  const previous = await cdp.evaluate<{ directory?: string; id?: string }>(`(() => {
    const tab = document.querySelector('[data-component="session-tab"][data-active="true"]');
    return { directory: tab?.dataset.directory, id: tab?.dataset.sessionId };
  })()`)
  log(
    `effective keybind overrides=${JSON.stringify(await cdp.evaluate(`window.api.storeGet("default.dat", "settings.v3").then(v => JSON.parse(v || "{}").keybinds)`))}`,
  )
  await cdp.evaluate("window.api.setWindowFocus()")
  await cdp.call("Page.bringToFront")
  let originalClipboard: string | undefined
  const readClipboard = async () => {
    const result = Bun.spawnSync(["/usr/bin/pbpaste"])
    assert.equal(result.exitCode, 0, "native clipboard read")
    return result.stdout.toString()
  }
  const request = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const result = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(directory),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    assert.ok(result.ok, `${method} ${path}: ${result.status}`)
    return result.status === 204 ? undefined : result.json()
  }
  const wait = async <T>(label: string, test: () => Promise<T>, timeout = 30_000): Promise<NonNullable<T>> => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const result = await test()
      if (result) return result as NonNullable<T>
      await Bun.sleep(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const exists = (selector: string) => cdp.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)
  const click = async (selector: string, button: "left" | "right" = "left") => {
    await wait(`click ${selector}`, () => exists(selector))
    const point = await cdp.evaluate<{ x: number; y: number }>(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center", inline: "center" });
      const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, clickCount: 1 })
    await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, clickCount: 1 })
  }
  const navigate = (dir: string, id: string) =>
    cdp.evaluate(`window.__referenceClipboardNavigation = (async () => {
    const { handleNotificationClick } = await import(${JSON.stringify(`${app}/utils/notification-click.ts`)});
    handleNotificationClick(${JSON.stringify(`/${Buffer.from(dir).toString("base64url")}/session/${id}`)});
  })()`)
  let sourceID: string | undefined
  let targetID: string | undefined
  const marker = `SESSION_CLIPBOARD_QA_${Date.now()}`
  try {
    await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true })
    originalClipboard = await readClipboard()
    sourceID = (await request("/session", "POST", { title: "QA copied session reference" })).id
    await request(`/session/${sourceID}/message`, "POST", {
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: `The verification token for this conversation is ${marker}.` }],
    })
    targetID = (await request("/session", "POST", { title: "QA pasted session reference" })).id
    await navigate(directory, sourceID!)
    const sourceTab = `[data-component="session-tab"][data-session-id="${sourceID}"]`
    await wait("source session active", () => exists(`${sourceTab}[data-active="true"]`))
    await click(sourceTab, "right")
    const copyMenu = `[data-action="session-tab-copy-reference"][data-session="${Buffer.from(sourceID!).toString("base64url")}"]`
    await wait("copy reference menu", () => exists(copyMenu))
    assert.equal(
      await cdp.evaluate(`document.querySelector(${JSON.stringify(copyMenu)}).previousElementSibling.dataset.action`),
      "session-tab-reference-new",
    )
    await click(copyMenu)
    const copied = await wait("reference written to real clipboard", async () => {
      const text = await readClipboard()
      return readSessionReferenceClipboard(text)?.sessionID === sourceID ? text : undefined
    })
    assert.ok(readSessionReferenceClipboard(copied)?.summary.includes(marker))
    log("PASS tab context menu copies the real server snapshot immediately below reference-in-new-session")

    await navigate(directory, targetID!)
    await wait("target session active", () =>
      exists(`[data-component="session-tab"][data-session-id="${targetID}"][data-active="true"]`),
    )
    await wait("empty target editor", () =>
      cdp.evaluate(`document.querySelector(${JSON.stringify(editor)})?.textContent === ""`),
    )
    await cdp.evaluate(`document.querySelector(${JSON.stringify(editor)}).focus()`)
    await cdp.call("Input.insertText", { text: "Before replace after" })
    await cdp.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(editor)}); e.focus();
      const range = document.createRange(); range.setStart(e.firstChild, 7); range.setEnd(e.firstChild, 14);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`)
    await cdp.evaluate('window.api.runDesktopMenuAction("edit.paste")')
    const capsule = `${editor} [data-type="session"]`
    const card = `[data-component="session-reference"][data-session-id="${sourceID}"]`
    await wait("native paste creates capsule and card", async () => (await exists(capsule)) && (await exists(card)))
    assert.equal(
      await cdp.evaluate(`JSON.parse(document.querySelector(${JSON.stringify(capsule)}).dataset.reference).sessionID`),
      sourceID,
    )
    const text = await cdp.evaluate<string>(`document.querySelector(${JSON.stringify(editor)}).textContent`)
    assert.ok(text.startsWith("Before @QA copied session reference"))
    assert.ok(text.endsWith(" after"))
    assert.ok(!text.includes("replace") && !text.includes("opencode://"))
    assert.equal(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(card)}).length`), 1)
    log(
      "PASS native Electron paste replaces selected text with a capsule and one snapshot card, preserving surrounding text",
    )

    await cdp.evaluate(`(() => {
      const e = document.querySelector(${JSON.stringify(editor)}); e.focus();
      const range = document.createRange(); range.selectNodeContents(e); range.collapse(false);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`)
    await cdp.call("Input.insertText", {
      text: " Reply only with the verification token in the attached session excerpt. Do not use tools.",
    })
    const needsModel = await cdp.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll('[data-prompt-composer] button')].find(e => /^(选择模型|Select model)$/.test(e.textContent.trim()));
      if (!button) return false;
      button.click(); return true;
    })()`)
    if (needsModel) {
      const model = '[data-model-selector-popover-content] [data-key="axonhub:deepseek-v4.1-flash"]'
      await wait("configured test model", () => exists(model))
      await click(model)
      log("selected configured test model for the temporary session")
    }
    const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
    await Bun.write("/tmp/opencode-session-reference-clipboard.png", Buffer.from(shot.data, "base64"))
    await click('[data-action="prompt-submit"]')
    await wait(
      "model receives pasted reference",
      async () => {
        const messages = await request(`/session/${targetID}/message`)
        const user = messages.find((message: any) => message.info.role === "user")
        const references = user?.parts.filter((part: any) => part.metadata?.sessionReference)
        assert.ok(!references || references.length <= 1)
        return messages.some(
          (message: any) =>
            message.info.role === "assistant" &&
            message.info.time.completed &&
            message.parts.some((part: any) => part.type === "text" && part.text.includes(marker)),
        )
      },
      120_000,
    )
    log(`PASS pasted snapshot sent through sidecar and model replied with ${marker}`)
  } finally {
    if (originalClipboard !== undefined) {
      const restored = Bun.spawnSync({ cmd: ["/usr/bin/pbcopy"], stdin: new TextEncoder().encode(originalClipboard) })
      assert.equal(restored.exitCode, 0, "native clipboard restored")
    }
    for (const id of [targetID, sourceID].filter(Boolean)) {
      await cdp.evaluate(
        `document.querySelector('[data-component="session-tab"][data-session-id="${id}"] [data-action="session-tab-close"]')?.click()`,
      )
      await request(`/session/${id}/abort`, "POST").catch(() => {})
      await request(`/session/${id}`, "DELETE")
    }
    if (previous.directory && previous.id) await navigate(previous.directory, previous.id)
    await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: false })
    log("temporary sessions removed; clipboard and previous session restored")
  }
})
