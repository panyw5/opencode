type CdpTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

type CdpResponse = {
  id?: number
  result?: unknown
  error?: { message: string }
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:9222"

export class CdpClient {
  private nextID = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse
      if (message.id === undefined) return
      const callback = this.pending.get(message.id)
      if (!callback) return
      this.pending.delete(message.id)
      if (message.error) callback.reject(new Error(message.error.message))
      else callback.resolve(message.result)
    })
    socket.addEventListener("close", () => {
      for (const callback of this.pending.values()) callback.reject(new Error("CDP connection closed"))
      this.pending.clear()
    })
  }

  static async connect(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error(`Unable to connect to ${url}`)), { once: true })
    })
    return new CdpClient(socket)
  }

  call<T>(method: string, params: Record<string, unknown> = {}) {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextID++
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate<T>(expression: string) {
    const response = await this.call<{ result: { value?: T; description?: string }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
    )
    if (response.exceptionDetails) throw new Error(response.result.description ?? "Renderer evaluation failed")
    return response.result.value as T
  }

  close() {
    this.socket.close()
  }
}

export async function listTargets(endpoint = DEFAULT_ENDPOINT) {
  const response = await fetch(`${endpoint}/json/list`)
  if (!response.ok) throw new Error(`CDP target request failed: ${response.status} (${endpoint})`)
  return (await response.json()) as CdpTarget[]
}

export function pickPageTarget(targets: CdpTarget[]) {
  return targets.find((item) => item.type === "page" && (item.url.startsWith("http") || item.url.startsWith("oc://")))
}

export async function connectCdp(endpoint = DEFAULT_ENDPOINT) {
  const targets = await listTargets(endpoint)
  const target = pickPageTarget(targets)
  if (!target) {
    throw new Error(
      `No Electron page target at ${endpoint}. Confirm the dev app is running (bun run dev:desktop) and listening on 9222.`,
    )
  }
  const client = await CdpClient.connect(target.webSocketDebuggerUrl)
  return { client, target, targets }
}

export async function withCdp<T>(fn: (client: CdpClient, target: CdpTarget) => Promise<T>, endpoint = DEFAULT_ENDPOINT) {
  const { client, target } = await connectCdp(endpoint)
  try {
    return await fn(client, target)
  } finally {
    client.close()
  }
}

function usage() {
  return [
    "Control the already-running OpenCode Dev Electron app over CDP :9222.",
    "Does not launch or quit any app. Verify 9222 is the dev renderer before using.",
    "",
    "Usage: bun packages/desktop/scripts/cdp.ts <command> [args]",
    "",
    "Commands:",
    "  targets                         List CDP targets",
    "  info                            URL, title, viewport, visible buttons",
    "  eval <js>                       Runtime.evaluate, print JSON",
    "  click <text|selector>           Click by visible text or CSS selector",
    "  click-xy <x> <y>                Click viewport CSS pixels",
    "  type <text>                     Type into the focused element",
    "  press <key>                     Press a key (Enter, Escape, Tab, ...)",
    "  screenshot [path]               Save a PNG (default /tmp/opencode-cdp.png)",
    "  snapshot                        Compact list of clickable labels",
    "",
    "Env: OPENCODE_CDP_ENDPOINT (default http://127.0.0.1:9222)",
  ].join("\n")
}

const CLICK_JS = String.raw`((query) => {
  const visible = (el) => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }
  const label = (el) => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim()
  const selector = query.startsWith("#") || query.startsWith(".") || query.startsWith("[") || query.includes(">")
  let el = selector ? document.querySelector(query) : null
  if (!el) {
    const nodes = [...document.querySelectorAll("button, a, [role='button'], [role='tab'], [role='menuitem'], summary, label")]
    el = nodes.find((item) => visible(item) && label(item) === query)
      ?? nodes.find((item) => visible(item) && label(item).includes(query))
  }
  if (!el) return { ok: false, error: "not found", query }
  el.scrollIntoView({ block: "center", inline: "center" })
  if (el instanceof HTMLElement) el.click()
  else el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }))
  return { ok: true, query, text: label(el), tag: el.tagName.toLowerCase() }
})`

const INFO_JS = `(() => ({
  href: location.href,
  title: document.title,
  readyState: document.readyState,
  viewport: { w: window.innerWidth, h: window.innerHeight },
  buttons: [...document.querySelectorAll("button, a, [role='button']")]
    .map((el) => (el.innerText || el.getAttribute("aria-label") || "").trim())
    .filter(Boolean)
    .slice(0, 40),
}))()`

const SNAPSHOT_JS = `(() => {
  const items = [...document.querySelectorAll("button, a, [role='button'], [role='tab'], [role='menuitem'], h1, h2, h3, input, textarea")]
  return items.slice(0, 80).map((el) => {
    const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\\s+/g, " ")
    return { tag: el.tagName.toLowerCase(), text: text.slice(0, 80), type: el.getAttribute("type") }
  }).filter((item) => item.text)
})()`

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command || command === "--help" || command === "-h") {
    console.log(usage())
    return
  }

  const endpoint = Bun.env.OPENCODE_CDP_ENDPOINT || DEFAULT_ENDPOINT

  if (command === "targets") {
    const targets = await listTargets(endpoint)
    console.log(JSON.stringify(targets.map(({ id, type, title, url }) => ({ id, type, title, url })), null, 2))
    return
  }

  await withCdp(async (cdp) => {
    if (command === "info") {
      console.log(JSON.stringify(await cdp.evaluate(INFO_JS), null, 2))
      return
    }

    if (command === "eval") {
      const expression = args.slice(1).join(" ")
      if (!expression) throw new Error("eval requires a JavaScript expression")
      console.log(JSON.stringify(await cdp.evaluate(expression), null, 2))
      return
    }

    if (command === "click") {
      const query = args.slice(1).join(" ")
      if (!query) throw new Error("click requires text or a CSS selector")
      console.log(JSON.stringify(await cdp.evaluate(`${CLICK_JS}(${JSON.stringify(query)})`), null, 2))
      return
    }

    if (command === "click-xy") {
      const x = Number(args[1])
      const y = Number(args[2])
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click-xy requires numeric x y")
      await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
      console.log(JSON.stringify({ ok: true, x, y }))
      return
    }

    if (command === "type") {
      const text = args.slice(1).join(" ")
      if (!text) throw new Error("type requires text")
      await cdp.call("Input.insertText", { text })
      console.log(JSON.stringify({ ok: true, text }))
      return
    }

    if (command === "press") {
      const key = args[1]
      if (!key) throw new Error("press requires a key name")
      await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key })
      await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key })
      console.log(JSON.stringify({ ok: true, key }))
      return
    }

    if (command === "screenshot") {
      const path = args[1] || "/tmp/opencode-cdp.png"
      await cdp.call("Page.enable")
      const shot = await cdp.call<{ data: string }>("Page.captureScreenshot", { format: "png" })
      await Bun.write(path, Buffer.from(shot.data, "base64"))
      console.log(JSON.stringify({ ok: true, path }))
      return
    }

    if (command === "snapshot") {
      console.log(JSON.stringify(await cdp.evaluate(SNAPSHOT_JS), null, 2))
      return
    }

    throw new Error(`Unknown command: ${command}\n\n${usage()}`)
  }, endpoint)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
