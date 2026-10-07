import type { WebContents } from "electron"
import path from "node:path"
import { write as writeLog } from "./logging"

// CDP automation executor for one WebContentsView, built on webContents.debugger.
// Backs the P1-D-02 requirements; validated during P0-D-02 (see
// .tasks/browser-tools/prd.md appendix A for the mouseMoved/click-retry findings).

const log = (step: string, message: string, extra?: Record<string, unknown>) =>
  writeLog("browser", `cdp ${step}: ${message}`, extra)

// CDP Runtime.consoleAPICalled types are a wider set than our ConsoleEntry
// levels (e.g. console.warn() arrives as "warning"; there is also "debug",
// "assert", group/trace/table variants). Anything not mappable to the four
// server-side levels degrades to "log" — a mismatch here previously crashed
// the server-side frame decode and killed the whole bridge connection.
const CDP_CONSOLE_LEVELS: Record<string, "log" | "info" | "warn" | "error"> = {
  log: "log",
  debug: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  clear: "log",
  startGroup: "log",
  startGroupCollapsed: "log",
  endGroup: "log",
  count: "log",
  timeEnd: "log",
  info: "info",
  warning: "warn",
  error: "error",
  assert: "error",
}

const normalizeCdpConsoleLevel = (type: unknown): "log" | "info" | "warn" | "error" =>
  (typeof type === "string" && CDP_CONSOLE_LEVELS[type]) || "log"

export type SnapshotNode = {
  uid: string
  role: string
  name: string
  value?: string
  focused?: boolean
}

export type Snapshot = {
  url: string
  title: string
  nodes: SnapshotNode[]
}

// Roles worth exposing to the agent; keeps snapshots small on complex SPAs.
const INTERESTING_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "switch",
  "heading",
  "image",
  "dialog",
  "alert",
  "list",
  "listitem",
  "navigation",
  "main",
  "form",
])

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "switch",
])

type AxNode = {
  nodeId: string
  backendDOMNodeId?: number
  ignored?: boolean
  role?: { value: string }
  name?: { value: string }
  value?: { value: string }
  focused?: boolean
}

const NAVIGATE_TIMEOUT_MS = 20_000

export class BrowserCdp {
  private attached = false
  private domEnabled = false
  private consoleEnabled = false
  private networkEnabled = false
  private responseListeners = new Set<(response: { origin: string; path: string; status: number }) => void>()

  constructor(private readonly wc: WebContents) {}

  private get dbg() {
    return this.wc.debugger
  }

  async ensureAttached() {
    if (this.attached && this.dbg.isAttached()) return
    this.dbg.on("message", (_event, method, params) => this.onDebuggerMessage(method, params))
    this.dbg.attach("1.3")
    this.attached = true
    await this.dbg.sendCommand("Page.enable")
    await this.dbg.sendCommand("Runtime.enable")
    log("attach", "debugger attached", { webContentsId: this.wc.id })
  }

  private async onDebuggerMessage(method: string, params: Record<string, unknown>) {
    if (method === "Network.responseReceived") {
      const response = params.response as { url: string; status: number }
      try {
        const url = new URL(response.url)
        for (const listener of this.responseListeners)
          listener({ origin: url.origin, path: url.pathname, status: response.status })
      } catch {
        log("network", "response metadata inspection failed; no headers or bodies recorded")
      }
    }
    if (method === "Runtime.consoleAPICalled") {
      const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? []
      const text = args
        .map((arg) => (typeof arg.value === "string" ? arg.value : (arg.description ?? JSON.stringify(arg.value))))
        .join(" ")
      this.onConsoleEntry?.({
        level: normalizeCdpConsoleLevel(params.type),
        text,
        at: Date.now(),
      })
    }
  }

  onConsoleEntry?: (entry: { level: "log" | "info" | "warn" | "error"; text: string; at: number }) => void

  async onResponse(listener: (response: { origin: string; path: string; status: number }) => void) {
    await this.ensureAttached()
    if (!this.networkEnabled) {
      await this.dbg.sendCommand("Network.enable")
      this.networkEnabled = true
    }
    this.responseListeners.add(listener)
    return () => this.responseListeners.delete(listener)
  }

  /** Main-process-only evaluation. Never exposed as a generic page/tool IPC. */
  async evaluate<T>(expression: string): Promise<T> {
    await this.ensureAttached()
    const response = (await this.dbg.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value?: T }; exceptionDetails?: { text?: string } }
    if (response.exceptionDetails)
      throw new Error(`Browser evaluation failed: ${response.exceptionDetails.text ?? "page exception"}`)
    if (response.result.value === undefined) throw new Error("Browser evaluation returned no value")
    return response.result.value
  }

  async insertText(text: string) {
    await this.ensureAttached()
    await this.dbg.sendCommand("Input.insertText", { text })
  }
  /** Attach already-validated local files to a rendered file input via CDP. */
  async setInputFiles(selector: string, files: string[]) {
    if (!files.length) throw new Error("At least one file is required")
    if (files.some((file) => !path.isAbsolute(file))) throw new Error("File paths must be absolute")
    await this.ensureAttached()
    await this.dbg.sendCommand("DOM.enable")
    const document = (await this.dbg.sendCommand("DOM.getDocument", { depth: -1 })) as {
      root?: { nodeId?: number }
    }
    if (!document.root?.nodeId) throw new Error("Page document is unavailable")
    const query = JSON.stringify(selector)
    const eligibleCount = await this.evaluate<number>(`[...document.querySelectorAll(${query})].filter(input =>
      input instanceof HTMLInputElement && input.type === 'file' && !input.disabled &&
      input.getAttribute('aria-disabled') !== 'true' && !input.closest('[inert],[hidden],[aria-hidden="true"]')
    ).length`)
    if (!eligibleCount) throw new Error("Enabled file input was not found")
    if (eligibleCount !== 1) throw new Error("Enabled file input is ambiguous")
    const evaluated = (await this.dbg.sendCommand("Runtime.evaluate", {
      expression: `[...document.querySelectorAll(${query})].find(input => input instanceof HTMLInputElement && input.type === 'file' && !input.disabled && input.getAttribute('aria-disabled') !== 'true' && !input.closest('[inert],[hidden],[aria-hidden="true"]'))`,
    })) as { result?: { objectId?: string } }
    if (!evaluated.result?.objectId) throw new Error("Enabled file input was not found")
    const active = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
      objectId: evaluated.result.objectId,
      functionDeclaration:
        "function() { return this instanceof HTMLInputElement && this.type === 'file' && !this.disabled && this.getAttribute('aria-disabled') !== 'true' && !this.closest('[inert],[hidden],[aria-hidden=\\\"true\\\"]') }",
      returnByValue: true,
    })) as { result?: { value?: boolean } }
    if (active.result?.value !== true) throw new Error("File input is no longer enabled in the active composer")
    const requested = (await this.dbg.sendCommand("DOM.requestNode", { objectId: evaluated.result.objectId })) as {
      nodeId?: number
    }
    const nodeId = requested.nodeId
    if (!nodeId) throw new Error("Enabled file input disappeared")
    const input = (await this.dbg.sendCommand("DOM.describeNode", { nodeId })) as {
      node?: { nodeName?: string; attributes?: string[] }
    }
    const attrs = new Map<string, string>()
    for (let i = 0; i < (input.node?.attributes?.length ?? 0); i += 2)
      attrs.set(input.node!.attributes![i], input.node!.attributes![i + 1])
    if (input.node?.nodeName !== "INPUT" || attrs.get("type") !== "file")
      throw new Error("Selected control is not a file input")
    if (attrs.has("disabled") || attrs.get("aria-disabled") === "true")
      throw new Error("Selected file input is disabled")
    if (files.length > 1 && !attrs.has("multiple")) throw new Error("File input does not allow multiple files")
    await this.dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files })
    log("file-input", `files assigned count=${files.length}`)
  }
  async focus() {
    this.wc.focus()
    log("focus", "browser focused", { webContentsId: this.wc.id })
  }
  async pressEnter() {
    await this.ensureAttached()
    for (const type of ["rawKeyDown", "keyUp"])
      await this.dbg.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
  }
  async pressEscape() {
    await this.ensureAttached()
    this.wc.focus()
    for (const type of ["rawKeyDown", "keyUp"])
      await this.dbg.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      })
  }
  async pressArrowRight() {
    await this.ensureAttached()
    this.wc.focus()
    for (const type of ["rawKeyDown", "keyUp"])
      await this.dbg.sendCommand("Input.dispatchKeyEvent", {
        type,
        key: "ArrowRight",
        code: "ArrowRight",
        windowsVirtualKeyCode: 39,
        nativeVirtualKeyCode: 39,
      })
  }
  async clickSelector(selector: string, beforeDispatch?: () => Promise<void>) {
    const point = await this.evaluate<{ x: number; y: number }>(`(() => {
      const el=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length&&!e.closest('[inert],[aria-hidden="true"]')&&getComputedStyle(e).visibility!=='hidden').at(-1)
      if(!el) throw new Error('Control not found')
      el.scrollIntoView({block:'center'}); const r=el.getBoundingClientRect(); const point={x:r.x+r.width/2,y:r.y+r.height/2}
      const hit=document.elementFromPoint(point.x,point.y)
      if(!hit||!el.contains(hit)) throw new Error('Control is covered by another element; no click dispatched')
      return point
    })()`)
    await beforeDispatch?.()
    await this.dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
    })
    this.wc.focus()
    for (const type of ["mousePressed", "mouseReleased"])
      await this.dbg.sendCommand("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      })
  }

  async navigate(url: string) {
    // Plain navigation needs no debugger. Attaching the debugger to a
    // never-navigated webContents hangs: the renderer process (and its CDP
    // agent) does not exist until the first load completes. Debugger domains
    // are enabled lazily by snapshot/click/screenshot instead.
    const navigated = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`navigation timeout after ${NAVIGATE_TIMEOUT_MS}ms: ${url}`))
      }, NAVIGATE_TIMEOUT_MS)
      const onLoad = (_e: Electron.Event, loaded: string) => {
        // Resolve on ANY main-frame commit. Matching the requested URL prefix
        // here dead-locks on redirects: google.com → google.com.hk legitimately
        // changes the host, so the prefix never matches and navigation "times
        // out" after a perfectly successful load (observed live 2026-09-29).
        void loaded
        cleanup()
        resolve()
      }
      const onFail = (_e: Electron.Event, code: number, desc: string, failed: string, isMain: boolean) => {
        if (!isMain) return
        cleanup()
        reject(new Error(`did-fail-load ${code} ${desc}: ${failed}`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.wc.off("did-navigate", onLoad)
        this.wc.off("did-fail-load", onFail)
      }
      this.wc.on("did-navigate", onLoad)
      this.wc.on("did-fail-load", onFail)
    })
    await this.wc.loadURL(url).catch((error) => {
      // loadURL rejects on ERR_ABORTED (e.g. redirect); the did-navigate listener decides success.
      log("navigate", "loadURL rejected (possible redirect)", { url, error: String(error) })
    })
    await navigated
    return { url: this.wc.getURL(), title: this.wc.getTitle() }
  }

  async snapshot(limit = 400): Promise<Snapshot> {
    await this.ensureAttached()
    await this.dbg.sendCommand("Accessibility.enable")
    // give the AX tree a moment to materialize (P0 finding)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const ax = (await this.dbg.sendCommand("Accessibility.getFullAXTree", {})) as { nodes: AxNode[] }
    const nodes: SnapshotNode[] = []
    for (const node of ax.nodes) {
      if (node.ignored) continue
      const role = node.role?.value
      if (!role || !INTERESTING_ROLES.has(role)) continue
      const uid = node.backendDOMNodeId ? `n${node.backendDOMNodeId}` : `ax${node.nodeId}`
      nodes.push({
        uid,
        role,
        name: node.name?.value ?? "",
        value: node.value?.value,
        focused: node.focused,
      })
      if (nodes.length >= limit) break
    }
    return { url: this.wc.getURL(), title: this.wc.getTitle(), nodes }
  }

  async screenshot(fullPage = false) {
    await this.ensureAttached()
    // Hidden (agent-partition) views may throttle painting; captureScreenshot
    // forces a frame, but background throttling must be off to get pixels.
    const img = (await this.dbg.sendCommand("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    })) as { data: string }
    return img.data
  }

  /** Resolve the click point for an AX uid and dispatch a trusted CDP click. */
  async click(uid: string, position?: { x: number; y: number }, beforeDispatch?: () => Promise<void>) {
    if (
      position &&
      (![position.x, position.y].every(Number.isFinite) ||
        position.x < 0 ||
        position.x > 1 ||
        position.y < 0 ||
        position.y > 1)
    )
      throw new Error("Click position must be inside the element (0..1)")
    const point = await this.resolveUidCenter(uid, position)
    if (!point) throw new Error(`element not found for uid ${uid} (page may have navigated; take a new snapshot)`)
    await this.ensureAttached()
    if (beforeDispatch) {
      const backendNodeId = Number.parseInt(uid.slice(1), 10)
      const resolved = (await this.dbg.sendCommand("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string }
      }
      if (!resolved.object?.objectId) throw new Error("Control disappeared before submission; no click dispatched")
      const hit = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration:
          "function(point) { return this.contains(document.elementFromPoint(point.x,point.y)) && !this.closest('[disabled],[aria-disabled=\"true\"],[inert]') }",
        arguments: [{ value: point }],
        returnByValue: true,
      })) as { result?: { value?: boolean } }
      if (hit.result?.value !== true) throw new Error("Control is disabled or covered; no click dispatched")
      await beforeDispatch()
    }
    const dbg = this.dbg
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" })
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await dbg.sendCommand("Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: "left",
        clickCount: 1,
        buttons: type === "mousePressed" ? 1 : 0,
      })
    }
    // Navigation triggered by the click happens asynchronously: wait briefly
    // for it to start and finish so the reported URL/title reflect the result
    // of the interaction (P2-S-04 acceptance).
    await this.waitForNavigationSettle()
    return { x: point.x, y: point.y }
  }

  /**
   * Wait for a click-triggered navigation: up to 500ms for one to start
   * (URL change or loading indicator), then until loading finishes (capped).
   * SPA state toggles that never navigate return after the start window.
   */
  private async waitForNavigationSettle() {
    const urlBefore = this.wc.getURL()
    const startDeadline = Date.now() + 500
    const settleDeadline = Date.now() + 10_000
    let navigated = false
    while (Date.now() < settleDeadline) {
      const loading = this.wc.isLoading()
      const moved = this.wc.getURL() !== urlBefore
      if (!navigated) {
        if (loading || moved) navigated = true
        else if (Date.now() >= startDeadline) return
      } else if (!loading) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  async type(uid: string, text: string, opts?: { clear?: boolean; submit?: boolean }) {
    await this.click(uid)
    if (opts?.clear !== false) {
      // Clear via the DOM, not the keyboard: ctrl/cmd+A select-all through CDP
      // needs per-platform modifiers + virtual key codes and silently failed
      // live on google.com.hk (2026-09-29) — the second type() appended and
      // duplicated the text. The React native value setter keeps controlled
      // inputs (Google search is one) registering the change.
      await this.dbg.sendCommand("Runtime.evaluate", {
        expression: `(() => {
          const el = document.activeElement
          if (!el) return
          if (el.isContentEditable) {
            const selection = window.getSelection()
            const range = document.createRange()
            range.selectNodeContents(el)
            selection.removeAllRanges()
            selection.addRange(range)
            return
          }
          if (typeof el.value !== "string") return
          const setter =
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set ??
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
          if (setter) setter.call(el, "")
          else el.value = ""
          el.dispatchEvent(new Event("input", { bubbles: true }))
          el.dispatchEvent(new Event("change", { bubbles: true }))
        })()`,
      })
      const editable = await this.evaluate<boolean>("document.activeElement?.isContentEditable === true")
      if (editable)
        for (const type of ["rawKeyDown", "keyUp"])
          await this.dbg.sendCommand("Input.dispatchKeyEvent", {
            type,
            key: "Backspace",
            code: "Backspace",
            windowsVirtualKeyCode: 8,
            nativeVirtualKeyCode: 8,
          })
    }
    await this.dbg.sendCommand("Input.insertText", { text })
    if (opts?.submit) {
      await this.dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
      await this.dbg.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      })
      // form submits navigate; wait for the landing page
      await this.waitForNavigationSettle()
    }
    return { typed: text.length, url: this.wc.getURL(), title: this.wc.getTitle() }
  }

  /**
   * Scroll the page. With `uid`, brings that element into view (center);
   * otherwise wheels the viewport center by `amount` px (default ~90% of
   * the viewport) in `direction`. Wheel events go through the real input
   * pipeline, so inner scroll containers and scroll-bound SPAs react like
   * they do for a human user — window.scrollBy would miss both.
   */
  async scroll(opts?: { uid?: string; direction?: "up" | "down"; amount?: number }) {
    await this.ensureAttached()
    const uid = opts?.uid
    if (uid) {
      if (!this.domEnabled) {
        await this.dbg.sendCommand("DOM.enable")
        this.domEnabled = true
      }
      const backendNodeId = uid.startsWith("n") ? Number.parseInt(uid.slice(1), 10) : Number.NaN
      if (Number.isNaN(backendNodeId)) throw new Error(`invalid uid ${uid} (take a new browser_read snapshot)`)
      const resolved = (await this.dbg.sendCommand("DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string }
      }
      const objectId = resolved.object?.objectId
      if (!objectId) throw new Error(`element not found for uid ${uid} (page may have navigated; take a new snapshot)`)
      await this.dbg.sendCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function () { this.scrollIntoView({ block: 'center', behavior: 'instant' }) }",
      })
    } else {
      const vp = (await this.dbg.sendCommand("Runtime.evaluate", {
        expression: "JSON.stringify({ w: window.innerWidth, h: window.innerHeight })",
        returnByValue: true,
      })) as { result?: { value?: string } }
      let width = 800
      let height = 600
      try {
        const parsed = JSON.parse(vp.result?.value ?? "{}") as { w?: unknown; h?: unknown }
        if (typeof parsed.w === "number" && parsed.w > 0) width = parsed.w
        if (typeof parsed.h === "number" && parsed.h > 0) height = parsed.h
      } catch {
        // viewport probe failed — the defaults still wheel a sane distance
      }
      const pixels = opts?.amount ?? Math.round(height * 0.9)
      const deltaY = opts?.direction === "up" ? -pixels : pixels
      await this.dbg.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(width / 2),
        y: Math.round(height / 2),
        deltaX: 0,
        deltaY,
      })
    }
    // scrollIntoView/wheel apply synchronously; a short settle keeps the
    // returned title/url fresh for pages that react to scrolling.
    await new Promise((resolve) => setTimeout(resolve, 150))
    return { url: this.wc.getURL(), title: this.wc.getTitle() }
  }

  private async resolveUidCenter(
    uid: string,
    position?: { x: number; y: number },
  ): Promise<{ x: number; y: number } | undefined> {
    await this.ensureAttached()
    if (!this.domEnabled) {
      await this.dbg.sendCommand("DOM.enable")
      this.domEnabled = true
    }
    const backendNodeId = uid.startsWith("n") ? Number.parseInt(uid.slice(1), 10) : undefined
    if (backendNodeId === undefined || Number.isNaN(backendNodeId)) return undefined
    try {
      const box = (await this.dbg.sendCommand("DOM.getBoxModel", { backendNodeId })) as {
        model?: { content: number[] }
      }
      const content = box.model?.content
      if (!content || content.length < 8) return undefined
      // content quad: [x1,y1, x2,y2, x3,y3, x4,y4] in CSS pixels
      const xs = [content[0], content[2], content[4], content[6]]
      const ys = [content[1], content[3], content[5], content[7]]
      const x = Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * (position?.x ?? 0.5)
      const y = Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * (position?.y ?? 0.5)
      return { x, y }
    } catch (error) {
      log("click", "getBoxModel failed", { uid, error: String(error) })
      return undefined
    }
  }
  async matches(uid: string, selector: string): Promise<boolean> {
    await this.ensureAttached()
    const backendNodeId = uid.startsWith("n") ? Number.parseInt(uid.slice(1), 10) : Number.NaN
    if (!Number.isFinite(backendNodeId)) throw new Error("Invalid element uid; take a new browser_read snapshot")
    const resolved = (await this.dbg.sendCommand("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string }
    }
    if (!resolved.object?.objectId) throw new Error("Element no longer exists; take a new browser_read snapshot")
    const result = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(selector) { return !!this.closest(selector) }",
      arguments: [{ value: selector }],
      returnByValue: true,
    })) as { result?: { value?: boolean }; exceptionDetails?: unknown }
    if (result.exceptionDetails) throw new Error("Element inspection failed")
    return result.result?.value === true
  }
  async matchesText(uid: string, pattern: string): Promise<boolean> {
    await this.ensureAttached()
    const backendNodeId = uid.startsWith("n") ? Number.parseInt(uid.slice(1), 10) : Number.NaN
    if (!Number.isFinite(backendNodeId)) throw new Error("Invalid element uid; take a new browser_read snapshot")
    const resolved = (await this.dbg.sendCommand("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string }
    }
    if (!resolved.object?.objectId) throw new Error("Element no longer exists; take a new browser_read snapshot")
    const result = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration:
        "function(pattern) { const el=this.closest('button,[role=button]')||this; const label=el.getAttribute('aria-label')||el.innerText||el.textContent||''; return new RegExp(pattern,'i').test(label.trim()) }",
      arguments: [{ value: pattern }],
      returnByValue: true,
    })) as { result?: { value?: boolean }; exceptionDetails?: unknown }
    if (result.exceptionDetails) throw new Error("Element text inspection failed")
    return result.result?.value === true
  }

  close() {
    this.responseListeners.clear()
    this.networkEnabled = false
    if (this.attached && this.dbg.isAttached()) this.dbg.detach()
    this.attached = false
  }

  back() {
    this.wc.navigationHistory.goBack()
  }

  forward() {
    this.wc.navigationHistory.goForward()
  }

  reload() {
    this.wc.reload()
  }
}
