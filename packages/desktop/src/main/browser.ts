import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { BrowserWindow, session, WebContentsView, type Rectangle } from "electron"
import { write as writeLog } from "./logging"
import { BrowserCdp } from "./browser-cdp"
import type { BrowserDisplayFrame } from "@opencode-ai/app/browser/types"

// P1-D-01: owns the embedded browser WebContentsViews. One controller per app;
// views are keyed by session partition. The user view uses a persistent
// partition (cookies survive restarts); agent views get ephemeral per-session
// partitions (added in P2).

const log = (step: string, message: string, extra?: Record<string, unknown>) =>
  writeLog("browser", `${step}: ${message}`, extra)

export const USER_PARTITION = "persist:browse"
// Canonical agent partition naming. Defined here AND in
// packages/opencode/src/browser/index.ts (server, derives from sessionID) AND
// referenced via AGENT_PARTITION_PREFIX in packages/app/src/pages/session/browser-panel.tsx
// (renderer, detects agent tabs). No shared package spans desktop+server, so
// the three stay in sync by convention — change all three together.
export const agentPartition = (sessionID: string) => `agent-browser-${sessionID}`

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

const HIDDEN_VIEW_BOUNDS = { x: -32000, y: 0, width: 1, height: 1 }

// Local file support: anything with a scheme (http:, file:, about:, ...) passes
// through untouched; bare absolute paths and ~-prefixed paths are converted to
// file:// URLs. This is the single choke point for every navigation source —
// the panel address bar (IPC) and the agent browser_* tools (bridge) both land
// in controller.open(), so the conversion lives here rather than at each caller.
// Relative paths are deliberately not resolved: the main process cwd is the
// app launch dir, which is meaningless for sessions rooted elsewhere.
export function normalizeTargetUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  let path = trimmed
  if (path.startsWith("~/")) path = homedir() + path.slice(1)
  if (path.startsWith("/")) return pathToFileURL(path).toString()
  return trimmed
}

export type ViewState = {
  partition: string
  url: string
  title: string
  loading: boolean
  shared: boolean
  /** View generation: incremented on every (re)creation of this partition.
   * Events emitted before a teardown carry the old epoch, so consumers can
   * drop stale in-flight events instead of resurrecting dead tabs. */
  epoch: number
}

export type BrowserPresentation = { id: number; state: ViewState }

type ViewEntry = {
  view: WebContentsView
  cdp: BrowserCdp
  visible: boolean
  shared: boolean
  bounds?: Rectangle
  win?: BrowserWindow
  /** monotonic clock (ms) of the last state emission / command touching the view */
  lastActivity: number
}

type ControllerEvents = {
  onViewState?: (state: ViewState) => void
  onConsole?: (entry: { partition: string; level: "log" | "info" | "warn" | "error"; text: string; at: number }) => void
}

export class BrowserController {
  private views = new Map<string, ViewEntry>()
  // Generation counter per partition. Survives view deletion so a partition
  // reopened after close (agent re-navigating) gets a strictly larger epoch
  // than every event emitted by the previous generation.
  private epochs = new Map<string, number>()
  private owner: BrowserWindow | undefined
  private displaySequence = 0
  private displayLease = 0
  private displayRevision = -1
  private presentation?: BrowserPresentation
  private presentationSequence = 0
  private presentationListeners = new Set<(request: BrowserPresentation) => void>()
  private viewStateListeners = new Set<(state: ViewState) => void>()
  private viewClosedListeners = new Set<(partition: string, epoch: number) => void>()
  private reapTimer: NodeJS.Timeout | undefined
  events: ControllerEvents = {}

  /** Subscribe to view state changes (url/title/loading). Returns unsubscribe. */
  onViewState(listener: (state: ViewState) => void) {
    this.viewStateListeners.add(listener)
    return () => this.viewStateListeners.delete(listener)
  }

  /** Subscribe to view teardowns (user close, agent close, renderer crash,
   * stale-attach cleanup, idle reap). Carries the closed view's epoch so
   * consumers can block stale in-flight state events. Returns unsubscribe. */
  onViewClosed(listener: (partition: string, epoch: number) => void) {
    this.viewClosedListeners.add(listener)
    return () => this.viewClosedListeners.delete(listener)
  }

  /** Bind views to the main window. Safe to call again with a recreated window. */
  attachWindow(win: BrowserWindow) {
    const replaced = this.owner !== win
    if (replaced) {
      this.displayLease = 0
      this.displayRevision = -1
    }
    this.owner = win
    for (const [partition, entry] of this.views) {
      if (entry.view.webContents.isDestroyed()) {
        // A destroyed view must vanish through the same path as any other
        // teardown — silently dropping it here used to leave a zombie tab in
        // the renderer strip (no closed event was ever emitted).
        this.teardown(partition, "stale-attach")
        continue
      }
      try {
        if (replaced) entry.visible = false
        win.contentView.addChildView(entry.view)
        entry.win = win
        this.applyBounds(partition)
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
    view.setBounds(HIDDEN_VIEW_BOUNDS)
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
      // Must go through teardown: emitState would find no entry and emit
      // NOTHING, leaving a forever-idle unclickable tab in the strip.
      log("renderer", "gone", { partition, ...details })
      this.teardown(partition, "renderer-gone")
    })

    const cdp = new BrowserCdp(view.webContents)
    cdp.onConsoleEntry = (entry) => this.events.onConsole?.({ partition, ...entry })

    const epoch = (this.epochs.get(partition) ?? 0) + 1
    this.epochs.set(partition, epoch)
    const entry: ViewEntry = { view, cdp, visible: false, shared: false, lastActivity: Date.now() }
    if (this.owner && !this.owner.isDestroyed()) {
      this.owner.contentView.addChildView(view)
      entry.win = this.owner
    }
    this.views.set(partition, entry)
    log("create", "view created", { partition, epoch, attached: Boolean(this.owner && !this.owner.isDestroyed()) })
    this.startReaper()
    return entry
  }

  private emitState(partition: string) {
    const entry = this.views.get(partition)
    if (entry) entry.lastActivity = Date.now()
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
      epoch: this.epochs.get(partition) ?? 0,
    }
  }

  getState(): ViewState[] {
    return [...this.views.keys()].map((partition) => this.viewState(partition)).filter((s) => s !== undefined)
  }

  has(partition: string) {
    return this.views.has(partition)
  }

  /** Mark a view as recently used (idle reaper bookkeeping). */
  private touch(partition: string) {
    const entry = this.views.get(partition)
    if (entry) entry.lastActivity = Date.now()
  }

  /** Navigate (creating the view if needed) and make it visible. */
  async open(partition: string, url: string) {
    const target = normalizeTargetUrl(url)
    const entry = this.ensure(partition)
    entry.lastActivity = Date.now()
    this.applyBounds(partition)
    if (target !== entry.view.webContents.getURL()) {
      await entry.cdp.navigate(target).catch((error) => {
        log("open", "navigate failed", { partition, url: target, error: String(error) })
        throw error
      })
    }
    this.applyBounds(partition)
    return this.viewState(partition)
  }

  setBounds(partition: string, bounds: Rectangle | null) {
    if (this.displayLease) {
      log("display", `ignored legacy bounds partition=${partition} lease=${this.displayLease}`)
      return
    }
    const entry = this.views.get(partition)
    if (!entry) return
    if (bounds && JSON.stringify(bounds) !== JSON.stringify(entry.bounds))
      log("bounds", `partition=${partition} x=${bounds.x} y=${bounds.y} width=${bounds.width} height=${bounds.height}`)
    entry.bounds = bounds ?? undefined
    this.applyBounds(partition)
  }

  private applyBounds(partition: string) {
    const entry = this.views.get(partition)
    if (!entry) return
    const bounds = entry.bounds
    const shouldShow = entry.visible && Boolean(bounds)
    // On macOS a hidden native view can still intercept mouse input at its old bounds.
    // Keep its requested bounds separately and park the actual view offscreen while hidden.
    const actual = shouldShow && bounds ? bounds : HIDDEN_VIEW_BOUNDS
    entry.view.setBounds(actual)
    entry.view.setVisible(shouldShow)
    log(
      "hit-region",
      `partition=${partition} visible=${shouldShow} x=${actual.x} y=${actual.y} width=${actual.width} height=${actual.height}`,
    )
  }

  acquireDisplay() {
    this.displayLease = ++this.displaySequence
    this.displayRevision = -1
    for (const [partition, entry] of this.views) {
      entry.visible = false
      this.applyBounds(partition)
    }
    log("display", `acquired lease=${this.displayLease}`)
    return this.displayLease
  }

  getDisplayState() {
    return {
      lease: this.displayLease,
      revision: this.displayRevision,
      views: [...this.views]
        .filter(([, entry]) => !entry.view.webContents.isDestroyed())
        .map(([partition, entry]) => ({
          partition, visible: entry.view.getVisible(), bounds: entry.view.getBounds(),
        })),
    }
  }

  updateDisplay(frame: BrowserDisplayFrame) {
    if (!frame || !Number.isSafeInteger(frame.lease) || !Number.isSafeInteger(frame.revision) || frame.revision < 1) {
      log("display", "rejected invalid display version")
      return false
    }
    if (frame.lease !== this.displayLease || !this.displayLease || frame.revision <= this.displayRevision) {
      log(
        "display",
        `rejected stale lease=${frame.lease} revision=${frame.revision} current=${this.displayLease}/${this.displayRevision}`,
      )
      return false
    }
    const bounds = frame.bounds
    if (
      (frame.partition !== null && typeof frame.partition !== "string") ||
      ((frame.partition === null) !== (bounds === null)) ||
      (bounds && (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) || bounds.width < 1 || bounds.height < 1))
    ) {
      log("display", `rejected invalid bounds lease=${frame.lease}`)
      return false
    }
    this.displayRevision = frame.revision
    // One transaction owns every native hit region. Hidden tabs retain their requested geometry.
    for (const [partition, entry] of this.views) {
      const visible = partition === frame.partition && !!bounds
      entry.visible = visible
      if (visible) entry.bounds = bounds!
      if (!visible) this.applyBounds(partition)
    }
    if (frame.partition) this.applyBounds(frame.partition)
    log("display", `applied lease=${frame.lease} revision=${frame.revision} partition=${frame.partition ?? "none"} visible=${!!bounds}`)
    return !frame.partition || this.views.has(frame.partition)
  }

  releaseDisplay(lease: number) {
    if (lease !== this.displayLease) return
    for (const [partition, entry] of this.views) {
      entry.visible = false
      this.applyBounds(partition)
    }
    this.displayLease = 0
    log("display", `released lease=${lease}`)
  }

  /** Request the existing sidebar, retaining the request across route changes. */
  present(partition: string) {
    const state = this.viewState(partition)
    if (!state) throw new Error(`no browser view for partition ${partition}`)
    this.touch(partition)
    const request = { id: ++this.presentationSequence, state }
    this.presentation = request
    log("present", `sidebar requested partition=${partition} request=${request.id} epoch=${state.epoch}`)
    for (const listener of this.presentationListeners) {
      try {
        listener(request)
      } catch (error) {
        log("present", `sidebar listener failed request=${request.id} error=${String(error)}`)
      }
    }
  }

  onPresented(listener: (request: BrowserPresentation) => void) {
    this.presentationListeners.add(listener)
    return () => this.presentationListeners.delete(listener)
  }

  getPresentation() {
    if (!this.presentation) return
    const state = this.viewState(this.presentation.state.partition)
    return state ? { id: this.presentation.id, state } : undefined
  }

  acknowledgePresentation(id: number) {
    if (this.presentation?.id !== id) return
    log("present", `sidebar mounted request=${id}`)
    this.presentation = undefined
  }

  setVisible(partition: string, visible: boolean) {
    if (this.displayLease) {
      log("display", `ignored legacy visibility partition=${partition} visible=${visible} lease=${this.displayLease}`)
      return
    }
    // No ensure-create here: this is called from the renderer visibility
    // effect for every known tab, and silently creating a view nobody
    // navigates used to be the footgun behind zombie tabs. View creation is
    // converged on open() — the only entry point that comes with a URL.
    const entry = this.views.get(partition)
    if (!entry) {
      if (visible) log("visible", "ignored for unknown partition", { partition, visible })
      return
    }
    if (visible) {
      for (const [other, view] of this.views) {
        if (other === partition) continue
        view.visible = false
        this.applyBounds(other)
      }
    }
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
    this.touch(partition)
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
      this.applyBounds(partition)
    }
  }

  close(partition: string) {
    this.teardown(partition, "close")
  }

  /**
   * The single teardown path: every way a view can vanish goes through here
   * and always notifies the closed listeners (renderer + server bridge), so
   * no consumer can be left with a stale tab.
   */
  private teardown(partition: string, reason: string) {
    const entry = this.views.get(partition)
    if (!entry) return
    this.views.delete(partition)
    entry.cdp.close()
    if (entry.win && !entry.win.isDestroyed()) {
      try {
        entry.win.contentView.removeChildView(entry.view)
      } catch (error) {
        log("teardown", "removeChildView failed", { partition, reason, error: String(error) })
      }
    }
    entry.win = undefined
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close()
      log("teardown", `webContents closed partition=${partition}; persistent login retained`)
    }
    if (this.presentation?.state.partition === partition) this.presentation = undefined
    const epoch = this.epochs.get(partition) ?? 0
    log("teardown", reason, { partition, epoch })
    for (const listener of this.viewClosedListeners) {
      try {
        listener(partition, epoch)
      } catch (error) {
        log("teardown", "closed listener failed", { partition, reason, error: String(error) })
      }
    }
  }

  /** CDP handle for an EXISTING view. Does not create views: agent commands
   * against a missing partition must fail loudly (the tool reports it) instead
   * of silently materializing a blank view nobody drives. */
  cdp(partition: string): BrowserCdp | undefined {
    this.touch(partition)
    return this.views.get(partition)?.cdp
  }

  // Agent partitions are ephemeral, but sessions can simply be abandoned —
  // without a reaper the views Map only grows, and every idle view keeps a
  // renderer process alive (background throttling is disabled for CDP). Reap
  // hidden agent views that saw no activity for AGENT_IDLE_TTL_MS; the next
  // agent navigation recreates the view fresh (documented semantics).
  private static readonly AGENT_IDLE_TTL_MS = 30 * 60_000
  private static readonly REAP_INTERVAL_MS = 60_000

  private reapIdle() {
    const now = Date.now()
    for (const [partition, entry] of this.views) {
      if (!partition.startsWith("agent-browser-")) continue // user views are never reaped
      if (entry.visible) continue // user is watching this tab
      if (now - entry.lastActivity < BrowserController.AGENT_IDLE_TTL_MS) continue
      this.teardown(partition, "idle-reap")
    }
  }

  private startReaper() {
    if (this.reapTimer) return
    this.reapTimer = setInterval(() => this.reapIdle(), BrowserController.REAP_INTERVAL_MS)
    this.reapTimer.unref?.()
  }

  dispose() {
    for (const partition of [...this.views.keys()]) this.teardown(partition, "dispose")
    if (this.reapTimer) clearInterval(this.reapTimer)
    this.reapTimer = undefined
  }
}

// Session.fromPartition warm-up so the user partition exists before first use.
export function warmupBrowserSession(partition: string) {
  session.fromPartition(partition)
  log("session", "warm", { partition })
}

export const browserController = new BrowserController()
