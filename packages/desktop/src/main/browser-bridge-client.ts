import { BrowserController, USER_PARTITION, type ViewState } from "./browser"
import { write as writeLog } from "./logging"
import { getGptProController } from "./gpt-pro-runtime"
import type { GptProCommand, GptProBrowserCommand } from "@opencode-ai/util/gpt-pro"

// P1-D-03: connects the opencode server to the in-app browser. Main process
// acts as the WS client; the server sends commands, we execute them against
// the BrowserController and answer with resp frames. Reconnects with capped
// exponential backoff (validated during P0-D-03).

const log = (step: string, message: string, extra?: Record<string, unknown>) =>
  writeLog("browser", `bridge-client ${step}: ${message}`, extra)

const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 8_000

export type ServerInfo = {
  url: string
  username: string | null
  password: string | null
}

export class BridgeClient {
  private info: ServerInfo | null = null
  private ws: WebSocket | undefined
  private generation = 0
  private stopped = false
  // Controller subscriptions from the current start(); re-starting must not
  // stack duplicate listeners (start() used to register unconditionally).
  private unsubs: Array<() => void> = []

  constructor(private readonly controller: BrowserController) {}

  start(info: ServerInfo) {
    this.info = info
    this.stopped = false
    this.unsubscribeController()
    this.unsubs.push(
      this.controller.onViewState((state) => this.sendEvent("browser.updated", state)),
      this.controller.onViewClosed((pageID, epoch, profileID) =>
        this.sendEvent("browser.closed", { pageID, partition: pageID, profileID, epoch }),
      ),
    )
    this.controller.events.onConsole = (entry) => this.sendEvent("browser.console", entry)
    const timer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      for (const event of getGptProController().notifications()) this.sendEvent("gpt-pro.notification", event)
    }, 2000)
    this.unsubs.push(() => clearInterval(timer))
    void this.connectLoop(++this.generation, 0)
  }

  stop() {
    this.stopped = true
    this.generation++
    this.ws?.close()
    this.ws = undefined
    this.unsubscribeController()
  }

  private unsubscribeController() {
    for (const unsub of this.unsubs) unsub()
    this.unsubs = []
  }

  private async connectLoop(generation: number, attempt: number) {
    if (this.stopped || generation !== this.generation || !this.info) return
    try {
      await this.connectOnce()
      log("connect", "connected")
      return // connected; close handler schedules the next loop
    } catch (error) {
      const next = attempt + 1
      const backoff = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5), RECONNECT_CAP_MS)
      log("connect", `attempt ${next} failed, retrying in ${backoff}ms`, { error: String(error) })
      await new Promise((resolve) => setTimeout(resolve, backoff))
      void this.connectLoop(generation, next)
    }
  }

  private async ticket(): Promise<string> {
    const info = this.info!
    const headers: Record<string, string> = { "x-opencode-ticket": "1" }
    if (info.username && info.password) {
      headers.Authorization = `Basic ${Buffer.from(`${info.username}:${info.password}`).toString("base64")}`
    }
    const response = await fetch(`${info.url}/browser/bridge/ticket`, {
      method: "POST",
      headers,
    })
    if (!response.ok) throw new Error(`ticket request failed: ${response.status}`)
    const body = (await response.json()) as { ticket: string }
    return body.ticket
  }

  private async connectOnce() {
    const info = this.info
    if (!info) throw new Error("no server info")
    const ticket = await this.ticket()
    const wsUrl = `${info.url.replace(/^http/, "ws")}/browser/bridge?ticket=${encodeURIComponent(ticket)}`
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    const generation = this.generation
    ws.addEventListener("open", () => {
      if (generation !== this.generation) {
        ws.close()
        return
      }
      this.send({
        type: "hello",
        client: "desktop",
        version: process.env.npm_package_version ?? "dev",
        views: this.controller.getState(),
      })
    })

    ws.addEventListener("message", (event) => {
      void this.handleFrame(String(event.data))
    })

    ws.addEventListener("close", () => {
      if (generation !== this.generation || this.stopped) return
      log("connect", "socket closed, reconnecting")
      void this.connectLoop(generation, 0)
    })

    ws.addEventListener("error", () => {
      // close follows; nothing to do here
    })
  }

  private send(frame: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }

  sendEvent(name: string, properties: Record<string, unknown>) {
    this.send({ type: "event", name, properties })
  }

  private async handleFrame(text: string) {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (frame.type === "gpt-pro-ack") {
      if (typeof frame.owner !== "string" || typeof frame.id !== "string") return
      const separator = frame.owner.lastIndexOf("\n")
      if (separator < 0) return
      getGptProController().acknowledge(frame.owner.slice(0, separator), [frame.id])
      return
    }
    if (frame.type !== "cmd") return
    const id = typeof frame.id === "string" ? frame.id : ""
    const name = typeof frame.name === "string" ? frame.name : ""
    const args = (frame.args ?? {}) as Record<string, unknown>
    try {
      const result = await this.execute(name, args)
      this.send({ type: "resp", id, ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log("cmd", `${name} failed`, { error: message })
      this.send({ type: "resp", id, ok: false, error: message })
    }
  }

  private async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    const pageID =
      typeof args.pageID === "string" && args.pageID
        ? args.pageID
        : typeof args.partition === "string" && args.partition
          ? args.partition
          : USER_PARTITION
    const controller = this.controller
    // cdp() no longer ensure-creates views: commands against a missing view
    // must fail loudly (the tool surfaces the error) instead of silently
    // materializing a blank view nobody navigates.
    const requireCdp = () => {
      const cdp = controller.cdp(pageID)
      if (!cdp) throw new Error(`no browser view open for page ${pageID} (navigate first)`)
      return cdp
    }
    switch (name) {
      case "gpt-pro-browser": {
        if (typeof args.owner !== "string" || typeof args.id !== "string" || typeof args.name !== "string")
          throw new Error("Missing consultation browser owner, id or operation")
        const operationArgs = args.args && typeof args.args === "object" ? (args.args as Record<string, unknown>) : {}
        return getGptProController().browserCommand(
          args.owner,
          args.id,
          args.name as GptProBrowserCommand,
          operationArgs,
          (pageID) => this.execute(args.name as string, { ...operationArgs, partition: pageID, pageID }),
        )
      }
      case "gpt-pro-notifications": {
        if (typeof args.directory !== "string" || !args.directory) throw new Error("Missing notification directory")
        return getGptProController().notifications(args.directory)
      }
      case "gpt-pro-ack": {
        if (
          typeof args.directory !== "string" ||
          !Array.isArray(args.ids) ||
          !args.ids.every((id) => typeof id === "string")
        )
          throw new Error("Invalid notification acknowledgement")
        getGptProController().acknowledge(args.directory, args.ids as string[])
        return true
      }
      case "gpt-pro-cancel-owner": {
        if (typeof args.directory !== "string" || !args.directory || typeof args.sessionID !== "string" || !args.sessionID)
          throw new Error("Missing stored session owner identity")
        const owner = `${args.directory}\n${args.sessionID}`
        const cancelled = getGptProController().cancelOwner(owner)
        return { cancelled }
      }
      case "gpt-pro": {
        if (typeof args.owner !== "string" || !args.owner || args.owner.length > 4096)
          throw new Error("Missing consultation owner")
        return getGptProController().command(args as GptProCommand, args.owner)
      }
      case "navigate": {
        const url = String(args.url ?? "")
        if (!url) throw new Error("navigate requires url")
        const state = await controller.open(pageID, url)
        return { state }
      }
      case "snapshot": {
        const snapshot = await requireCdp().snapshot()
        return { snapshot }
      }
      case "screenshot": {
        const data = await controller.captureScreenshot(pageID, args.fullPage === true)
        return { data, mime: "image/png" }
      }
      case "click": {
        const uid = String(args.uid ?? "")
        if (!uid) throw new Error("click requires uid")
        const position =
          args.position && typeof args.position === "object" ? (args.position as { x: number; y: number }) : undefined
        const point = await requireCdp().click(uid, position)
        return { point, state: controller.getState().find((s) => s.pageID === pageID || s.partition === pageID) }
      }
      case "type": {
        const uid = String(args.uid ?? "")
        const text = String(args.text ?? "")
        if (!uid) throw new Error("type requires uid")
        const result = await requireCdp().type(uid, text, {
          clear: args.clear !== false,
          submit: args.submit === true,
        })
        return { ...result, state: controller.getState().find((s) => s.pageID === pageID || s.partition === pageID) }
      }
      case "scroll": {
        const uid = typeof args.uid === "string" && args.uid ? args.uid : undefined
        const direction = args.direction === "up" ? ("up" as const) : ("down" as const)
        const amount = typeof args.amount === "number" && args.amount > 0 ? args.amount : undefined
        await requireCdp().scroll({ uid, direction, amount })
        return { state: controller.getState().find((s) => s.pageID === pageID || s.partition === pageID) }
      }
      case "back":
        requireCdp().back()
        return {}
      case "forward":
        requireCdp().forward()
        return {}
      case "reload":
        requireCdp().reload()
        return {}
      case "state": {
        const state = controller.getState().find((s) => s.pageID === pageID || s.partition === pageID)
        return { state }
      }
      case "close": {
        controller.close(pageID)
        return {}
      }
      default:
        throw new Error(`unknown browser command: ${name}`)
    }
  }
}

export type { ViewState }
