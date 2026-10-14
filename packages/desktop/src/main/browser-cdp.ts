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

export type BeforeTrustedClick = () => Promise<void | (() => void)> | void | (() => void)

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
  value?: { value: string | number | boolean }
  focused?: boolean
}

const NAVIGATE_TIMEOUT_MS = 20_000

export class BrowserCdp {
  private attached = false
  private domEnabled = false
  private consoleEnabled = false
  private networkEnabled = false
  private viewportQueue: Promise<void> = Promise.resolve()
  private responseListeners = new Set<(response: { origin: string; path: string; status: number }) => void>()

  constructor(private readonly wc: WebContents) {}

  private get dbg() {
    return this.wc.debugger
  }

  private async releaseRemoteObject(objectId?: string) {
    if (!objectId) return
    try {
      await this.dbg.sendCommand("Runtime.releaseObject", { objectId })
    } catch {
      log("object", "remote DOM object release skipped")
    }
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

  /** Set Chromium's layout viewport independently of the native view bounds. */
  async setViewport(width: number, height: number) {
    if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1)
      throw new Error("Browser viewport dimensions must be positive integers")
    const apply = this.viewportQueue.then(async () => {
      await this.ensureAttached()
      await this.dbg.sendCommand("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await this.dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true })
      log(
        "viewport",
        `device metrics and page focus emulation applied width=${width} height=${height} webContentsId=${this.wc.id}`,
      )
    })
    this.viewportQueue = apply.catch(() => {})
    await apply
  }

  async setFocusEmulation(enabled: boolean) {
    const apply = this.viewportQueue.then(async () => {
      await this.ensureAttached()
      await this.dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled })
      log("focus-emulation", `page focus emulation enabled=${enabled} webContentsId=${this.wc.id}`)
    })
    this.viewportQueue = apply.catch(() => {})
    await apply
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
  private async resolveComposerFileInput(expression: string) {
    const evaluated = (await this.dbg.sendCommand("Runtime.evaluate", { expression })) as {
      result?: { objectId?: string }
    }
    const resolverObjectId = evaluated.result?.objectId
    if (!resolverObjectId) {
      log("file-input", "composer resolver returned no object")
      throw new Error("Composer attachment resolver returned no result")
    }
    let inputObjectId: string | undefined
    try {
      const diagnostics = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
        objectId: resolverObjectId,
        functionDeclaration:
          "function() { return { editorCount:this.editorCount, globalInputCount:this.globalInputCount, eligibleGlobalInputCount:this.eligibleGlobalInputCount, scopedInputCount:this.scopedInputCount, reason:this.reason } }",
        returnByValue: true,
      })) as {
        result?: {
          value?: {
            editorCount?: number
            globalInputCount?: number
            eligibleGlobalInputCount?: number
            scopedInputCount?: number
            reason?: string
          }
        }
      }
      const result = diagnostics.result?.value
      log(
        "file-input",
        `composer resolver editorCount=${result?.editorCount ?? -1} globalInputs=${result?.globalInputCount ?? -1} eligibleGlobalInputs=${result?.eligibleGlobalInputCount ?? -1} scopedInputs=${result?.scopedInputCount ?? -1} reason=${result?.reason ?? "missing"}`,
      )
      if (result?.reason !== "ok")
        throw new Error(`Active composer file input unavailable: ${result?.reason ?? "resolver failed"}`)
      const inputHandle = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
        objectId: resolverObjectId,
        functionDeclaration: "function() { return this.input }",
      })) as { result?: { objectId?: string } }
      if (!inputHandle.result?.objectId) {
        log("file-input", "composer resolver input reference disappeared")
        throw new Error("Active composer input disappeared")
      }
      inputObjectId = inputHandle.result.objectId
      const requested = (await this.dbg.sendCommand("DOM.requestNode", {
        objectId: inputHandle.result.objectId,
      })) as { nodeId?: number }
      if (!requested.nodeId) {
        log("file-input", "composer resolver DOM request returned no node")
        throw new Error("Active composer input could not be resolved")
      }
      const described = (await this.dbg.sendCommand("DOM.describeNode", { nodeId: requested.nodeId })) as {
        node?: { backendNodeId?: number; nodeName?: string; attributes?: string[] }
      }
      const attrs = new Map<string, string>()
      for (let i = 0; i < (described.node?.attributes?.length ?? 0); i += 2)
        attrs.set(described.node!.attributes![i], described.node!.attributes![i + 1])
      if (described.node?.nodeName !== "INPUT" || attrs.get("type") !== "file") {
        log("file-input", "composer resolver selected a non-file node")
        throw new Error("Composer resolver selected a non-file control")
      }
      if (attrs.has("disabled") || attrs.get("aria-disabled") === "true") {
        log("file-input", "composer resolver selected a disabled node")
        throw new Error("Composer file input is disabled")
      }
      if (!described.node.backendNodeId) {
        log("file-input", "composer resolver node had no backend identity")
        throw new Error("Composer file input has no backend node identity")
      }
      return { nodeId: requested.nodeId, backendNodeId: described.node.backendNodeId, attrs }
    } finally {
      await this.releaseRemoteObject(inputObjectId)
      await this.releaseRemoteObject(resolverObjectId)
    }
  }

  /** Attach already-validated local files to a rendered file input via CDP. */
  async setInputFiles(
    selector: string,
    files: string[],
    composerResolverExpression?: string,
    beforeDispatch?: () => Promise<void>,
  ) {
    if (!files.length) throw new Error("At least one file is required")
    if (files.some((file) => !path.isAbsolute(file))) throw new Error("File paths must be absolute")
    await this.ensureAttached()
    await this.dbg.sendCommand("DOM.enable")
    const document = (await this.dbg.sendCommand("DOM.getDocument", { depth: -1 })) as {
      root?: { nodeId?: number }
    }
    if (!document.root?.nodeId) throw new Error("Page document is unavailable")
    let nodeId: number
    let backendNodeId: number | undefined
    let attrs: Map<string, string>
    if (composerResolverExpression) {
      const selected = await this.resolveComposerFileInput(composerResolverExpression)
      nodeId = selected.nodeId
      backendNodeId = selected.backendNodeId
      attrs = selected.attrs
      log("file-input", `composer input selected backendNodeId=${backendNodeId} phase=initial`)
    } else {
      const query = JSON.stringify(selector)
      const eligibleCount = await this.evaluate<number>(`[...document.querySelectorAll(${query})].filter(input =>
        input instanceof HTMLInputElement && input.type === 'file' && !input.disabled &&
        input.getAttribute('aria-disabled') !== 'true' && !input.parentElement?.closest('[inert],[hidden],[aria-hidden="true"]')
      ).length`)
      log("file-input", `generic resolver selectorMatches=${eligibleCount} phase=initial`)
      if (!eligibleCount) throw new Error("Enabled file input was not found")
      if (eligibleCount !== 1) throw new Error("Enabled file input is ambiguous")
      const queryInput = (await this.dbg.sendCommand("Runtime.evaluate", {
        expression: `[...document.querySelectorAll(${query})].find(input => input instanceof HTMLInputElement && input.type === 'file' && !input.disabled && input.getAttribute('aria-disabled') !== 'true' && !input.parentElement?.closest('[inert],[hidden],[aria-hidden="true"]'))`,
      })) as { result?: { objectId?: string } }
      if (!queryInput.result?.objectId) throw new Error("Enabled file input was not found")
      try {
        const active = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
          objectId: queryInput.result.objectId,
          functionDeclaration: `function() {
            return this instanceof HTMLInputElement && this.type === 'file' && !this.disabled &&
              this.getAttribute('aria-disabled') !== 'true' &&
              !this.parentElement?.closest('[inert],[hidden],[aria-hidden="true"]')
          }`,
          returnByValue: true,
        })) as { result?: { value?: boolean } }
        if (active.result?.value !== true) throw new Error("File input is no longer enabled")
        const requested = (await this.dbg.sendCommand("DOM.requestNode", { objectId: queryInput.result.objectId })) as {
          nodeId?: number
        }
        if (!requested.nodeId) throw new Error("Enabled file input disappeared")
        nodeId = requested.nodeId
        const input = (await this.dbg.sendCommand("DOM.describeNode", { nodeId })) as {
          node?: { backendNodeId?: number; nodeName?: string; attributes?: string[] }
        }
        attrs = new Map<string, string>()
        for (let i = 0; i < (input.node?.attributes?.length ?? 0); i += 2)
          attrs.set(input.node!.attributes![i], input.node!.attributes![i + 1])
        backendNodeId = input.node?.backendNodeId
        if (input.node?.nodeName !== "INPUT" || attrs.get("type") !== "file")
          throw new Error("Selected control is not a file input")
        if (attrs.has("disabled") || attrs.get("aria-disabled") === "true")
          throw new Error("Selected file input is disabled")
      } finally {
        await this.releaseRemoteObject(queryInput.result.objectId)
      }
    }
    if (files.length > 1 && !attrs.has("multiple")) throw new Error("File input does not allow multiple files")
    if (composerResolverExpression) {
      const current = await this.resolveComposerFileInput(composerResolverExpression)
      if (current.backendNodeId !== backendNodeId)
        throw new Error("Active composer changed before file dispatch; no upload was sent to a stale input")
      nodeId = current.nodeId
      log("file-input", `composer input revalidated backendNodeId=${current.backendNodeId} phase=dispatch`)
    }
    await beforeDispatch?.()
    await this.dbg.sendCommand("DOM.setFileInputFiles", { nodeId, files })
    log("file-input", `files assigned count=${files.length} backendNodeId=${backendNodeId ?? "unknown"}`)
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

  private async resolveElementExpression(expression: string) {
    await this.ensureAttached()
    await this.dbg.sendCommand("DOM.enable")
    const document = (await this.dbg.sendCommand("DOM.getDocument", { depth: 0 })) as {
      root?: { nodeId?: number }
    }
    if (!document.root?.nodeId) throw new Error("Page document is unavailable")
    const selected = (await this.dbg.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: false,
      awaitPromise: true,
    })) as { result?: { objectId?: string; subtype?: string; description?: string }; exceptionDetails?: unknown }
    if (selected.exceptionDetails) throw new Error("Resolved page target inspection failed")
    const objectId = selected.result?.objectId
    if (!objectId || selected.result?.subtype === "null") throw new Error("Resolved page target is unavailable")
    try {
      const requested = (await this.dbg.sendCommand("DOM.requestNode", { objectId })) as { nodeId?: number }
      if (!requested.nodeId) throw new Error("Resolved page target disappeared")
      const described = (await this.dbg.sendCommand("DOM.describeNode", { nodeId: requested.nodeId })) as {
        node?: { backendNodeId?: number; nodeName?: string; attributes?: string[] }
      }
      if (!described.node?.backendNodeId) throw new Error("Resolved page target has no backend identity")
      return { objectId, nodeId: requested.nodeId, backendNodeId: described.node.backendNodeId, nodeName: described.node.nodeName }
    } catch (error) {
      await this.releaseRemoteObject(objectId)
      throw error
    }
  }

  private async resolvedTargetPoint(objectId: string) {
    const inspected = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if (!(this instanceof HTMLButtonElement) || this.disabled || this.getAttribute('aria-disabled') === 'true') return null
        const style=getComputedStyle(this)
        if (!this.getClientRects().length || style.display==='none' || style.visibility==='hidden' || style.contentVisibility==='hidden' || this.closest('[inert],[hidden],[aria-hidden="true"]')) return null
        this.scrollIntoView({block:'center',inline:'center'})
        const rect=this.getBoundingClientRect()
        const point={x:rect.left+rect.width/2,y:rect.top+rect.height/2}
        const hit=document.elementFromPoint(point.x,point.y)
        if(!hit || (hit!==this&&!this.contains(hit))) return null
        return point
      }`,
      returnByValue: true,
    })) as { result?: { value?: { x: number; y: number } | null }; exceptionDetails?: unknown }
    if (inspected.exceptionDetails) throw new Error("Resolved page target hit test failed")
    return inspected.result?.value ?? undefined
  }

  /** Click the exact active DOM target returned by a shared page resolver. */
  async clickResolved(expression: string, beforeDispatch?: BeforeTrustedClick) {
    const initial = await this.resolveElementExpression(expression)
    if (initial.nodeName !== "BUTTON") {
      await this.releaseRemoteObject(initial.objectId)
      throw new Error("Resolved target is not a button; no click dispatched")
    }
    const initialPoint = await this.resolvedTargetPoint(initial.objectId).finally(() =>
      this.releaseRemoteObject(initial.objectId),
    )
    if (!initialPoint) throw new Error("Resolved button is disabled, hidden, or covered; no click dispatched")
    log("click", `resolved target validated backendNodeId=${initial.backendNodeId} phase=initial`)
    const commit = await beforeDispatch?.()

    const current = await this.resolveElementExpression(expression)
    if (current.nodeName !== "BUTTON" || current.backendNodeId !== initial.backendNodeId) {
      await this.releaseRemoteObject(current.objectId)
      throw new Error("Resolved send target changed before dispatch; no click dispatched")
    }
    const dbg = this.dbg
    const preMovePoint = await this.resolvedTargetPoint(current.objectId).finally(() =>
      this.releaseRemoteObject(current.objectId),
    )
    if (!preMovePoint) throw new Error("Resolved button became disabled, hidden, or covered; no click dispatched")
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: preMovePoint.x,
      y: preMovePoint.y,
      button: "none",
    })
    const finalTarget = await this.resolveElementExpression(expression)
    if (finalTarget.nodeName !== "BUTTON" || finalTarget.backendNodeId !== initial.backendNodeId) {
      await this.releaseRemoteObject(finalTarget.objectId)
      throw new Error("Resolved send target changed before mouse press; no click dispatched")
    }
    const point = await this.resolvedTargetPoint(finalTarget.objectId).finally(() =>
      this.releaseRemoteObject(finalTarget.objectId),
    )
    if (!point) throw new Error("Resolved button became disabled, hidden, or covered; no click dispatched")
    log("click", `resolved target revalidated backendNodeId=${finalTarget.backendNodeId} phase=dispatch`)
    commit?.()
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
      buttons: 1,
    })
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
      buttons: 0,
    })
    await this.waitForNavigationSettle()
    return { x: point.x, y: point.y, backendNodeId: finalTarget.backendNodeId }
  }

  /** Compare a snapshot UID with the exact target from the shared resolver. */
  async matchesResolved(uid: string, expression: string) {
    const expectedBackendNodeId = uid.startsWith("n") ? Number.parseInt(uid.slice(1), 10) : Number.NaN
    if (!Number.isFinite(expectedBackendNodeId)) throw new Error("Invalid element uid; take a new browser_read snapshot")
    const target = await this.resolveElementExpression(expression)
    await this.releaseRemoteObject(target.objectId)
    return target.nodeName === "BUTTON" && target.backendNodeId === expectedBackendNodeId
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
    let normalizedValues = 0
    for (const node of ax.nodes) {
      if (node.ignored) continue
      const role = node.role?.value
      if (!role || !INTERESTING_ROLES.has(role)) continue
      const uid = node.backendDOMNodeId ? `n${node.backendDOMNodeId}` : `ax${node.nodeId}`
      if (node.value && typeof node.value.value !== "string") normalizedValues++
      nodes.push({
        uid,
        role,
        name: node.name?.value ?? "",
        value: node.value?.value === undefined ? undefined : String(node.value.value),
        focused: node.focused,
      })
      if (nodes.length >= limit) break
    }
    log("browser", `snapshot nodes=${nodes.length} normalizedScalarValues=${normalizedValues}`)
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
  private async uidTargetHit(uid: string, point: { x: number; y: number }) {
    await this.ensureAttached()
    if (!this.domEnabled) {
      await this.dbg.sendCommand("DOM.enable")
      this.domEnabled = true
    }
    const backendNodeId = uid.startsWith("n") ? Number.parseInt(uid.slice(1), 10) : Number.NaN
    if (!Number.isFinite(backendNodeId)) return false
    const resolved = (await this.dbg.sendCommand("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string }
    }
    const objectId = resolved.object?.objectId
    if (!objectId) return false
    try {
      const hit = (await this.dbg.sendCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(point) { return this.contains(document.elementFromPoint(point.x,point.y)) && !this.closest('[disabled],[aria-disabled=\"true\"],[inert]') }",
        arguments: [{ value: point }],
        returnByValue: true,
      })) as { result?: { value?: boolean } }
      return hit.result?.value === true
    } finally {
      await this.releaseRemoteObject(objectId)
    }
  }

  async click(uid: string, position?: { x: number; y: number }, beforeDispatch?: BeforeTrustedClick) {
    if (
      position &&
      (![position.x, position.y].every(Number.isFinite) ||
        position.x < 0 ||
        position.x > 1 ||
        position.y < 0 ||
        position.y > 1)
    )
      throw new Error("Click position must be inside the element (0..1)")
    let point = await this.resolveUidCenter(uid, position)
    if (!point) throw new Error(`element not found for uid ${uid} (page may have navigated; take a new snapshot)`)
    let commit: void | (() => void) = undefined
    if (beforeDispatch) {
      if (!(await this.uidTargetHit(uid, point))) throw new Error("Control is disabled or covered; no click dispatched")
      commit = await beforeDispatch()
      point = await this.resolveUidCenter(uid, position)
      if (!point) throw new Error("Control disappeared before submission; no click dispatched")
      if (!(await this.uidTargetHit(uid, point))) throw new Error("Control is disabled or covered; no click dispatched")
    }
    const dbg = this.dbg
    await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" })
    if (beforeDispatch) {
      point = await this.resolveUidCenter(uid, position)
      if (!point) throw new Error(`element not found for uid ${uid} before mouse press; no click dispatched`)
      if (!(await this.uidTargetHit(uid, point))) throw new Error("Control is disabled or covered; no click dispatched")
    }
    commit?.()
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
      buttons: 1,
    })
    await dbg.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
      buttons: 0,
    })
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
