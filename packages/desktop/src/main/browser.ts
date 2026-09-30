import { BrowserWindow, session, WebContentsView, type Rectangle } from "electron"
import { write as writeLog } from "./logging"
import { BrowserCdp } from "./browser-cdp"

// P1-D-01: owns the embedded browser WebContentsViews. One controller per app;
// views are keyed by session partition. The user view uses a persistent
// partition (cookies survive restarts); agent views get ephemeral per-session
// partitions (added in P2).

const log = (step: string, message: string, extra?: Record<string, unknown>) =>
  writeLog("browser", `${step}: ${message}`, extra)

export const USER_PARTITION = "persist:browse"
export const agentPartition = (sessionID: string) => `agent-browser-${sessionID}`

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export type ViewState = {
  partition: string
  url: string
  title: string
  loading: boolean
  shared: boolean
}

type ViewEntry = {
  view: WebContentsView
  cdp: BrowserCdp
  visible: boolean
  shared: boolean
  bounds?: Rectangle
  win?: BrowserWindow
}

type ControllerEvents = {
  onViewState?: (state: ViewState) => void
  onConsole?: (entry: { partition: string; level: "log" | "info" | "warn" | "error"; text: string; at: number }) => void
}

export class BrowserController {
  private views = new Map<string, ViewEntry>()
  private owner: BrowserWindow | undefined
  private viewStateListeners = new Set<(state: ViewState) => void>()
  private viewClosedListeners = new Set<(partition: string) => void>()
  events: ControllerEvents = {}

  /** Subscribe to view state changes (url/title/loading). Returns unsubscribe. */
  onViewState(listener: (state: ViewState) => void) {
    this.viewStateListeners.add(listener)
    return () => this.viewStateListeners.delete(listener)
  }

  /** Subscribe to view teardowns. Returns unsubscribe. */
  onViewClosed(listener: (partition: string) => void) {
    this.viewClosedListeners.add(listener)
    return () => this.viewClosedListeners.delete(listener)
  }

  /** Bind views to the main window. Safe to call again with a recreated window. */
  attachWindow(win: BrowserWindow) {
    this.owner = win
    for (const [partition, entry] of this.views) {
      if (entry.view.webContents.isDestroyed()) {
        this.views.delete(partition)
        continue
      }
      try {
        win.contentView.addChildView(entry.view)
        entry.win = win
        if (entry.bounds) entry.view.setBounds(entry.bounds)
      } catch (error) {
        log("attach", "failed to re-attach view", { partition, error: String(error) })
      }
    }
  }

  private ensure(partition: string): ViewEntry {
    const existing = this.views.get(partition)
    if (existing && !existing.view.webContents.isDestroyed()) return existing
    if (existing) this.views.delete(partition)

    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    view.webContents.setUserAgent(BROWSER_USER_AGENT)
    // Agent partitions stay hidden (no panel bounds) — disable background
    // throttling so CDP screenshots/AX snapshots still get fresh frames.
    view.webContents.setBackgroundThrottling(false)
    view.setVisible(false)
    view.webContents.setWindowOpenHandler((details) => {
      // Never let pages pop real windows; report the URL back to the agent layer instead.
      log("window-open", "denied", { partition, url: details.url })
      void this.open(partition, details.url)
      return { action: "deny" }
    })
    view.webContents.on("did-navigate", (_e, url) => this.emitState(partition))
    view.webContents.on("did-navigate-in-page", (_e, url) => this.emitState(partition))
    view.webContents.on("did-start-loading", () => this.emitState(partition))
    view.webContents.on("did-stop-loading", () => this.emitState(partition))
    view.webContents.on("page-title-updated", () => this.emitState(partition))
    view.webContents.on("render-process-gone", (_e, details) => {
      log("renderer", "gone", { partition, ...details })
      this.views.delete(partition)
      this.emitState(partition)
    })

    const cdp = new BrowserCdp(view.webContents)
    cdp.onConsoleEntry = (entry) => this.events.onConsole?.({ partition, ...entry })

    const entry: ViewEntry = { view, cdp, visible: false, shared: false }
    if (this.owner && !this.owner.isDestroyed()) {
      this.owner.contentView.addChildView(view)
      entry.win = this.owner
    }
    this.views.set(partition, entry)
    log("create", "view created", { partition, attached: Boolean(this.owner && !this.owner.isDestroyed()) })
    return entry
  }

  private emitState(partition: string) {
    const state = this.viewState(partition)
    if (!state) return
    for (const listener of this.viewStateListeners) {
      try {
        listener(state)
      } catch (error) {
        log("emit", "view state listener failed", { error: String(error) })
      }
    }
  }

  private viewState(partition: string): ViewState | undefined {
    const entry = this.views.get(partition)
    if (!entry || entry.view.webContents.isDestroyed()) return undefined
    return {
      partition,
      url: entry.view.webContents.getURL(),
      title: entry.view.webContents.getTitle(),
      loading: entry.view.webContents.isLoading(),
      shared: entry.shared,
    }
  }

  getState(): ViewState[] {
    return [...this.views.keys()].map((partition) => this.viewState(partition)).filter((s) => s !== undefined)
  }

  has(partition: string) {
    return this.views.has(partition)
  }

  /** Navigate (creating the view if needed) and make it visible. */
  async open(partition: string, url: string) {
    const entry = this.ensure(partition)
    entry.view.setVisible(entry.visible)
    if (url !== entry.view.webContents.getURL()) {
      await entry.cdp.navigate(url).catch((error) => {
        log("open", "navigate failed", { partition, url, error: String(error) })
        throw error
      })
    }
    this.applyBounds(partition)
    return this.viewState(partition)
  }

  setBounds(partition: string, bounds: Rectangle | null) {
    const entry = this.views.get(partition)
    if (!entry) return
    entry.bounds = bounds ?? undefined
    this.applyBounds(partition)
  }

  private applyBounds(partition: string) {
    const entry = this.views.get(partition)
    if (!entry) return
    const bounds = entry.bounds
    const shouldShow = entry.visible && Boolean(bounds)
    entry.view.setVisible(shouldShow)
    if (bounds) entry.view.setBounds(bounds)
  }

  setVisible(partition: string, visible: boolean) {
    const entry = this.ensure(partition)
    entry.visible = visible
    this.applyBounds(partition)
    log("visible", visible ? "shown" : "hidden", { partition })
  }

  setShared(partition: string, shared: boolean) {
    const entry = this.views.get(partition)
    if (!entry) return
    entry.shared = shared
    this.emitState(partition)
  }

  /** Screenshot a view, working around the hidden-view frame starvation:
   * Page.captureScreenshot never resolves for a view that has never painted
   * (agent partitions stay hidden) because the compositor has no frames to
   * hand out — background throttling off is not enough. Park the view
   * offscreen and visible for the capture, then restore. (Live finding
   * 2026-09-29: agent screenshot timed out after 30s on a hidden view.) */
  async captureScreenshot(partition: string, fullPage: boolean) {
    const entry = this.views.get(partition)
    if (!entry) throw new Error(`no browser view for partition ${partition}`)
    const win = entry.win && !entry.win.isDestroyed() ? entry.win : undefined
    if (entry.visible || !win) return entry.cdp.screenshot(fullPage)
    entry.view.setBounds({ x: -32000, y: 0, width: 1280, height: 800 })
    entry.view.setVisible(true)
    log("screenshot", "transient offscreen show", { partition })
    try {
      // give the compositor a beat to start producing frames
      await new Promise((resolve) => setTimeout(resolve, 150))
      return await entry.cdp.screenshot(fullPage)
    } finally {
      entry.view.setVisible(false)
      if (entry.bounds) entry.view.setBounds(entry.bounds)
    }
  }

  close(partition: string) {
    const entry = this.views.get(partition)
    if (!entry) return
    entry.cdp.close()
    if (entry.win && !entry.win.isDestroyed()) entry.win.contentView.removeChildView(entry.view)
    entry.win = undefined
    this.views.delete(partition)
    log("close", "view closed", { partition })
    for (const listener of this.viewClosedListeners) listener(partition)
  }

  cdp(partition: string) {
    return this.ensure(partition).cdp
  }

  dispose() {
    for (const partition of [...this.views.keys()]) this.close(partition)
  }
}

// Session.fromPartition warm-up so the user partition exists before first use.
export function warmupBrowserSession(partition: string) {
  session.fromPartition(partition)
  log("session", "warm", { partition })
}

export const browserController = new BrowserController()
