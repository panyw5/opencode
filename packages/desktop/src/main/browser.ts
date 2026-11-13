import { homedir } from "node:os"
import { pathToFileURL } from "node:url"
import { BrowserWindow, nativeImage, session, WebContentsView, type Rectangle } from "electron"
import { write as writeLog } from "./logging"
import { BrowserCdp, type BrowserNavigationReason } from "./browser-cdp"
import type { BrowserDisplayFrame } from "@opencode-ai/app/browser/types"
import { isGptProProfile, type BrowserPageIdentity } from "@opencode-ai/util/gpt-pro"
import { GptProNavigationGuard } from "./gpt-pro-navigation"

// P1-D-01: owns the embedded browser WebContentsViews. One controller per app;
// views are keyed by pageID (one WebContents/CDP target per page). profileID is
// the Electron session partition and may intentionally be shared by pages.

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

const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
// Hidden views park with a 1px column inside the window's left edge. A fully
// offscreen rect never receives a layout viewport — measured live 2026-11-13:
// innerWidth stays 0 for a never-shown view and Page.captureScreenshot starves
// even for previously shown pages reparked at x=-32000. The sliver keeps
// layout live while remaining effectively invisible, and flipping setVisible
// is all a transient screenshot needs to produce frames.
const parkedBounds = (bounds?: Rectangle): Rectangle => {
  const width = bounds?.width ?? DEFAULT_VIEWPORT.width
  const height = bounds?.height ?? DEFAULT_VIEWPORT.height
  return { x: 1 - width, y: 0, width, height }
}

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
  /** Unique WebContents identity. Legacy pages use their partition as pageID. */
  pageID?: string
  /** Electron session identity. Defaults to the legacy partition. */
  profileID?: string
  owner?: BrowserPageIdentity["owner"]
  kind?: BrowserPageIdentity["kind"]
  partition: string
  url: string
  title: string
  loading: boolean
  shared: boolean
  /** View generation: incremented on every (re)creation of this pageID.
   * Events emitted before a teardown carry the old epoch, so consumers can
   * drop stale in-flight events instead of resurrecting dead tabs. */
  epoch: number
  /** Main-frame document generation, including same-URL reloads. */
  documentEpoch?: number
  navigationReason?: BrowserNavigationReason
  authRedirectLoop?: boolean
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
  identity: BrowserPageIdentity
  navigationGuard?: GptProNavigationGuard
  documentEpoch?: number
  navigationReason?: BrowserNavigationReason
  pendingNavigationReason?: BrowserNavigationReason
  /** Transient visibility requested by captureScreenshot for a hidden page.
   * reconcile() turns it into setVisible(true) on the parked sliver rect. */
  transientShow?: boolean
  /** Last rect/visibility actually pushed to the native view. Display frames
   * arrive per animation step; re-sending identical geometry causes flicker. */
  appliedBounds?: { x: number; y: number; width: number; height: number }
  appliedVisible?: boolean
}

const sameProtection = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((pageID) => b.has(pageID))

type ControllerEvents = {
  onViewState?: (state: ViewState) => void
  onConsole?: (entry: {
    partition: string
    pageID?: string
    profileID?: string
    level: "log" | "info" | "warn" | "error"
    text: string
    at: number
  }) => void
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
  private protectedPageID?: string
  private pendingPresentationPageID?: string
  private pendingPresentationTimer: NodeJS.Timeout | undefined
  private presentation?: BrowserPresentation
  private presentationSequence = 0
  private presentationListeners = new Set<(request: BrowserPresentation) => void>()
  private viewStateListeners = new Set<(state: ViewState) => void>()
  private viewClosedListeners = new Set<(pageID: string, epoch: number, profileID?: string, reason?: string) => void>()
  private protectionListeners = new Set<() => void>()
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
  onViewClosed(listener: (pageID: string, epoch: number, profileID?: string, reason?: string) => void) {
    this.viewClosedListeners.add(listener)
    return () => this.viewClosedListeners.delete(listener)
  }

  onProtectionChanged(listener: () => void) {
    this.protectionListeners.add(listener)
    return () => this.protectionListeners.delete(listener)
  }

  private emitProtectionChanged() {
    for (const listener of this.protectionListeners) {
      try {
        listener()
      } catch (error) {
        log("protection", `listener failed error=${String(error)}`)
      }
    }
  }

  /** The protected set is computed from three sources — visible, selected and
   * pending presentation — so every consumer sees the same truth. */
  private protectedPageIDs() {
    const protectedPages = new Set<string>()
    for (const [pageID, entry] of this.views)
      if (entry.visible || entry.transientShow) protectedPages.add(pageID)
    if (this.protectedPageID) protectedPages.add(this.protectedPageID)
    if (this.pendingPresentationPageID) protectedPages.add(this.pendingPresentationPageID)
    return protectedPages
  }

  isPageProtected(pageID: string) {
    return this.protectedPageIDs().has(pageID)
  }

  listConsultationPages() {
    return [...this.views].flatMap(([pageID, entry]) => {
      if (entry.identity.kind !== "consultation" || entry.view.webContents.isDestroyed()) return []
      return [
        {
          pageID,
          epoch: this.epochs.get(pageID) ?? 0,
          lastActivity: entry.lastActivity,
          protected: this.isPageProtected(pageID),
        },
      ]
    })
  }

  async setPageFocusEmulation(pageID: string, epoch: number, enabled: boolean) {
    const entry = this.views.get(pageID)
    if (!entry || entry.identity.kind !== "consultation" || (this.epochs.get(pageID) ?? 0) !== epoch) {
      log("focus-emulation", `pageID=${pageID} epoch=${epoch} enabled=${enabled} outcome=stale-or-missing`)
      return false
    }
    const applied = await entry.cdp.setFocusEmulation(enabled).then(
      () => this.views.get(pageID) === entry && (this.epochs.get(pageID) ?? 0) === epoch,
      (error) => {
        log(
          "focus-emulation",
          `pageID=${pageID} epoch=${epoch} enabled=${enabled} outcome=failed error=${String(error)}`,
        )
        return false
      },
    )
    log(
      `focus-emulation`,
      `pageID=${pageID} epoch=${epoch} enabled=${enabled} outcome=${applied ? "applied" : "stale-after-command"}`,
    )
    return applied
  }

  closeIfEpoch(pageID: string, epoch: number, reason: string) {
    if ((this.epochs.get(pageID) ?? 0) !== epoch || !this.views.has(pageID)) {
      log("teardown", `pageID=${pageID} epoch=${epoch} reason=${reason} outcome=stale-close-ignored`)
      return false
    }
    this.teardown(pageID, reason)
    return true
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
        this.reconcile(partition)
      } catch (error) {
        log("attach", "failed to re-attach view", { partition, error: String(error) })
      }
    }
  }

  private ensure(identity: BrowserPageIdentity): ViewEntry {
    const { pageID, profileID } = identity
    const existing = this.views.get(pageID)
    if (existing && existing.identity.profileID !== profileID)
      throw new Error(`Browser page ${pageID} already belongs to profile ${existing.identity.profileID}`)
    if (
      existing &&
      existing.identity.owner &&
      identity.owner &&
      (existing.identity.owner?.directory !== identity.owner.directory ||
        existing.identity.owner?.sessionID !== identity.owner.sessionID)
    )
      throw new Error(`Browser page ${pageID} already belongs to a different owner`)
    if (existing && existing.identity.kind && identity.kind && existing.identity.kind !== identity.kind)
      throw new Error(`Browser page ${pageID} already has kind ${existing.identity.kind ?? "unspecified"}`)
    if (existing && !existing.identity.owner && identity.owner) existing.identity.owner = identity.owner
    if (existing && !existing.identity.kind && identity.kind) existing.identity.kind = identity.kind
    if (existing && !existing.view.webContents.isDestroyed()) return existing
    if (existing) this.views.delete(pageID)

    const view = new WebContentsView({
      webPreferences: {
        partition: profileID,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    const isCurrent = () => this.views.get(pageID)?.view === view
    const navigationGuard = isGptProProfile(profileID) ? new GptProNavigationGuard() : undefined
    if (navigationGuard) {
      const onNavigate = (event: Electron.Event, url: string, _inPlace: boolean, isMainFrame: boolean) => {
        if (!isCurrent() || isMainFrame === false) return
        const allowed = navigationGuard.request(url)
        log(
          "navigation",
          `GPT login navigation requested pageID=${pageID} path=${new URL(url).pathname} allowed=${allowed}`,
        )
        if (allowed) return
        event.preventDefault()
        log("navigation", `login redirect loop stopped pageID=${pageID}; credentials and page contents preserved`)
        this.emitState(pageID)
      }
      view.webContents.on("will-navigate", onNavigate)
      view.webContents.on("will-redirect", onNavigate)
      // ChatGPT enters /auth/login via pushState before replacing the document
      // with /. will-navigate alone sees only repeated requests for /.
      const onCommitted = (_event: Electron.Event, url: string, isMainFrame?: boolean) => {
        if (!isCurrent() || isMainFrame === false) return
        const blocked = navigationGuard.blocked
        navigationGuard.allow(url)
        log(
          "navigation",
          `GPT login navigation committed pageID=${pageID} path=${new URL(url).pathname} blocked=${navigationGuard.blocked}`,
        )
        if (!blocked && navigationGuard.blocked)
          log("navigation", `login SPA redirect loop detected pageID=${pageID}; next navigation will be cancelled`)
        this.emitState(pageID)
      }
      view.webContents.on("did-navigate", (event, url) => onCommitted(event, url))
      view.webContents.on("did-navigate-in-page", onCommitted)
    }
    view.webContents.setUserAgent(BROWSER_USER_AGENT)
    // Agent partitions stay hidden (no panel bounds) — disable background
    // throttling so CDP screenshots/AX snapshots still get fresh frames.
    view.webContents.setBackgroundThrottling(false)
    // Do NOT set bounds/visibility before attach: a view parked while detached
    // never receives a layout viewport (innerWidth stays 0) and re-applying the
    // same rect after attach does not recover it — the Chromium widget dedups
    // the unchanged rect. The initial park must go through reconcile() once the
    // view is in a window (bounds first, then setVisible(false)).
    view.webContents.setWindowOpenHandler((details) => {
      // Never let pages pop real windows; report the URL back to the agent layer instead.
      log("window-open", "denied", { pageID, profileID, url: details.url })
      if (isCurrent())
        void this.openPage(pageID, profileID, details.url, {
          owner: identity.owner,
          kind: identity.kind,
        })
      return { action: "deny" }
    })
    view.webContents.on("did-navigate", () => isCurrent() && this.emitState(pageID))
    view.webContents.on("did-navigate-in-page", (_event, _url, isMainFrame) => {
      const entry = this.views.get(pageID)
      if (!isCurrent() || !entry || isMainFrame === false) return
      entry.navigationReason = entry.pendingNavigationReason ?? "website"
      entry.pendingNavigationReason = undefined
      this.emitState(pageID)
    })
    view.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
      if (!isCurrent() || !isMainFrame || isInPlace) return
      const entry = this.views.get(pageID)
      if (!entry) return
      entry.documentEpoch = (entry.documentEpoch ?? 0) + 1
      entry.navigationReason = entry.pendingNavigationReason ?? "website"
      entry.pendingNavigationReason = undefined
      log(
        "navigation",
        `document started pageID=${pageID} documentEpoch=${entry.documentEpoch} reason=${entry.navigationReason}; url omitted`,
      )
      this.emitState(pageID)
    })
    view.webContents.on("did-start-loading", () => isCurrent() && this.emitState(pageID))
    view.webContents.on("did-stop-loading", () => isCurrent() && this.emitState(pageID))
    view.webContents.on("page-title-updated", () => isCurrent() && this.emitState(pageID))
    view.webContents.on("render-process-gone", (_e, details) => {
      // Must go through teardown: emitState would find no entry and emit
      // NOTHING, leaving a forever-idle unclickable tab in the strip.
      if (isCurrent()) {
        log("renderer", "gone", { pageID, profileID, ...details })
        this.teardown(pageID, "renderer-gone")
      }
    })

    const cdp = new BrowserCdp(view.webContents, (reason) => {
      navigationGuard?.reset()
      const entry = this.views.get(pageID)
      if (entry) entry.pendingNavigationReason = reason
    })
    cdp.onConsoleEntry = (entry) => {
      if (!isCurrent()) return
      this.events.onConsole?.({ partition: pageID, pageID, profileID, ...entry })
    }

    const epoch = (this.epochs.get(pageID) ?? 0) + 1
    this.epochs.set(pageID, epoch)
    const entry: ViewEntry = {
      view,
      cdp,
      visible: false,
      shared: false,
      lastActivity: Date.now(),
      identity,
      navigationGuard,
    }
    if (this.owner && !this.owner.isDestroyed()) {
      this.owner.contentView.addChildView(view)
      entry.win = this.owner
    }
    this.views.set(pageID, entry)
    if (entry.win) this.reconcile(pageID)
    log(
      "create",
      `page created pageID=${pageID} profileID=${profileID} epoch=${epoch} kind=${identity.kind ?? "unspecified"} owner=${identity.owner ? `${identity.owner.directory ?? ""}/${identity.owner.sessionID ?? ""}` : "none"} attached=${Boolean(this.owner && !this.owner.isDestroyed())}`,
    )
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
      pageID: partition,
      profileID: entry.identity.profileID,
      owner: entry.identity.owner,
      kind: entry.identity.kind,
      partition,
      url: entry.view.webContents.getURL(),
      title: entry.view.webContents.getTitle(),
      loading: entry.view.webContents.isLoading(),
      shared: entry.shared,
      epoch: this.epochs.get(partition) ?? 0,
      documentEpoch: entry.documentEpoch ?? 0,
      navigationReason: entry.navigationReason,
      ...(entry.navigationGuard?.blocked ? { authRedirectLoop: true } : {}),
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
  async open(partition: string, url: string, reason: BrowserNavigationReason = "user") {
    const existing = this.views.get(partition)?.identity
    return this.openPage(
      partition,
      existing?.profileID ?? partition,
      url,
      {
        owner: existing?.owner,
        kind: existing?.kind,
      },
      reason,
    )
  }

  /** Open a distinct page backed by an existing/shared Electron session. */
  async openPage(
    pageID: string,
    profileID: string,
    url: string,
    metadata: Omit<BrowserPageIdentity, "pageID" | "profileID"> = {},
    reason: BrowserNavigationReason = "automation",
  ) {
    if (!pageID || !profileID) throw new Error("Browser pageID and profileID are required")
    const target = normalizeTargetUrl(url)
    const identity: BrowserPageIdentity = { pageID, profileID, ...metadata }
    const entry = this.ensure(identity)
    const redirectBlocked = entry.navigationGuard?.blocked
    entry.navigationGuard?.reset()
    entry.lastActivity = Date.now()
    if (redirectBlocked || target !== entry.view.webContents.getURL()) {
      await entry.cdp.navigate(target, reason).catch((error) => {
        log("open", "navigate failed", { pageID, profileID, url: target, error: String(error) })
        throw error
      })
    }
    if (this.isAutomationPage(entry)) {
      // Focus emulation is the only page override automation still needs:
      // layout always follows native bounds (parked sliver when hidden).
      await entry.cdp.setFocusEmulation(true).catch((error) => {
        log("focus-emulation", `pageID=${pageID} enabled=true outcome=failed error=${String(error)}`)
      })
    }
    return this.viewState(pageID)
  }

  /** The single funnel for every native rect/visibility change: all callers
   * only mutate the desired state (visible, bounds, transientShow) and then
   * reconcile, so no code path can bypass the parking/dedup rules. */
  private reconcile(partition: string) {
    const entry = this.views.get(partition)
    if (!entry) return
    const bounds = entry.bounds
    const shouldShow = (entry.visible && Boolean(bounds)) || entry.transientShow === true
    // On macOS a hidden native view can still intercept mouse input at its old
    // bounds, so hidden views keep their requested size parked offscreen with a
    // 1px column inside the window edge. The sliver preserves the layout
    // viewport (see parkedBounds) while intercepting almost no input.
    const parked = parkedBounds(bounds)
    const actual = entry.visible && bounds ? bounds : parked
    if (
      entry.appliedVisible === shouldShow &&
      entry.appliedBounds?.x === actual.x &&
      entry.appliedBounds.y === actual.y &&
      entry.appliedBounds.width === actual.width &&
      entry.appliedBounds.height === actual.height
    )
      return
    entry.appliedVisible = shouldShow
    entry.appliedBounds = actual
    entry.view.setBounds(actual)
    entry.view.setVisible(shouldShow)
    log(
      "hit-region",
      `partition=${partition} visible=${shouldShow} x=${actual.x} y=${actual.y} width=${actual.width} height=${actual.height}`,
    )
  }

  private isAutomationPage(entry: ViewEntry) {
    return (
      entry.identity.kind === "consultation" ||
      entry.identity.kind === "agent" ||
      entry.identity.pageID.startsWith("agent-browser-")
    )
  }

  /** Display leases belong to the owner window: a second window's panel (or a
   * stray caller) must not silently steal the lease and blank every view. */
  acquireDisplay(win?: BrowserWindow) {
    if (this.owner && win && win !== this.owner && !this.owner.isDestroyed()) {
      log("display", `acquire rejected: not the browser owner lease=${this.displayLease}`)
      throw new Error("browser display is owned by another window")
    }
    this.displayLease = ++this.displaySequence
    this.displayRevision = -1
    for (const [partition, entry] of this.views) {
      entry.visible = false
      this.reconcile(partition)
    }
    log("display", `acquired lease=${this.displayLease}`)
    return this.displayLease
  }

  focusedPartition(webContentsID: number | undefined, win: BrowserWindow) {
    if (webContentsID === undefined) return
    for (const [partition, entry] of this.views) {
      if (entry.win !== win || !entry.visible || entry.view.webContents.isDestroyed()) continue
      if (entry.view.webContents.id === webContentsID) return partition
    }
  }

  getDisplayState() {
    const visiblePageID = [...this.views].find(([, entry]) => entry.visible)?.[0]
    return {
      lease: this.displayLease,
      revision: this.displayRevision,
      protectedPageID: this.pendingPresentationPageID ?? this.protectedPageID,
      // Protection is visible ∪ selected ∪ pendingPresentation — all three
      // sources are exposed so diagnostics can see the complete state.
      protectedPageIDs: [...this.protectedPageIDs()],
      selectedPageID: this.protectedPageID,
      pendingPresentationPageID: this.pendingPresentationPageID,
      visiblePageID,
      views: [...this.views]
        .filter(([, entry]) => !entry.view.webContents.isDestroyed())
        .map(([pageID, entry]) => ({
          pageID,
          profileID: entry.identity.profileID,
          // Deprecated routing alias retained until the bridge/renderer migrate.
          partition: pageID,
          visible: entry.view.getVisible(),
          bounds: entry.view.getBounds(),
        })),
    }
  }

  async capturePreview(partition: string) {
    const entry = this.views.get(partition)
    if (!entry?.visible || entry.view.webContents.isDestroyed()) {
      log("preview", `skipped partition=${partition} reason=not-visible`)
      return
    }
    log("preview", `capture started partition=${partition}`)
    try {
      // Capture at the live viewport size before parking the native view. Unlike
      // tool screenshots this must never resize or temporarily show a hidden tab.
      const image = await entry.view.webContents.capturePage()
      if (image.isEmpty()) throw new Error("empty browser preview")
      const size = image.getSize()
      log("preview", `captured partition=${partition} width=${size.width} height=${size.height}`)
      return image.toDataURL()
    } catch (error) {
      log("preview", `failed partition=${partition} error=${String(error)}`)
      throw error
    }
  }

  async updateDisplay(frame: BrowserDisplayFrame) {
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
    const pageID = frame.pageID ?? null
    const bounds = frame.bounds
    if (
      (pageID !== null && typeof pageID !== "string") ||
      (frame.protectedPageID !== undefined &&
        frame.protectedPageID !== null &&
        typeof frame.protectedPageID !== "string") ||
      (pageID === null) !== (bounds === null) ||
      (bounds &&
        (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger) ||
          bounds.width < 1 ||
          bounds.height < 1))
    ) {
      log("display", `rejected invalid bounds lease=${frame.lease}`)
      return false
    }
    this.displayRevision = frame.revision
    const protectionBefore = this.protectedPageIDs()
    const selected = frame.protectedPageID === undefined ? pageID : frame.protectedPageID
    this.protectedPageID = selected ?? undefined
    if (this.pendingPresentationPageID && this.pendingPresentationPageID === this.protectedPageID)
      this.setPendingPresentation()
    // One transaction owns every native hit region. Hidden tabs retain their
    // requested geometry. The target is shown in the same pass — parking it
    // first and restoring it afterwards makes every resize frame flicker.
    for (const [partition, entry] of this.views) {
      const visible = partition === pageID && !!bounds
      entry.visible = visible
      if (visible) entry.bounds = bounds!
      this.reconcile(partition)
    }
    log(
      "display",
      `applied lease=${frame.lease} revision=${frame.revision} pageID=${pageID ?? "none"} visible=${!!bounds}`,
    )
    if (!sameProtection(protectionBefore, this.protectedPageIDs())) this.emitProtectionChanged()
    return !pageID || this.views.has(pageID)
  }

  releaseDisplay(lease: number) {
    if (lease !== this.displayLease) return
    const protectionBefore = this.protectedPageIDs()
    for (const [partition, entry] of this.views) {
      entry.visible = false
      this.reconcile(partition)
    }
    this.displayLease = 0
    this.protectedPageID = undefined
    if (!sameProtection(protectionBefore, this.protectedPageIDs())) this.emitProtectionChanged()
    log("display", `released lease=${lease}`)
  }

  // A pending presentation protects its page until a display frame confirms
  // it. If that frame never arrives (e.g. no window alive), the protection
  // must still expire instead of pinning the page forever.
  private static readonly PENDING_PRESENTATION_TTL_MS = 30_000

  private setPendingPresentation(pageID?: string) {
    if (this.pendingPresentationTimer) {
      clearTimeout(this.pendingPresentationTimer)
      this.pendingPresentationTimer = undefined
    }
    this.pendingPresentationPageID = pageID
    if (!pageID) return
    this.pendingPresentationTimer = setTimeout(() => {
      this.pendingPresentationTimer = undefined
      if (!this.pendingPresentationPageID) return
      log("present", `pending presentation protection expired pageID=${this.pendingPresentationPageID}`)
      this.pendingPresentationPageID = undefined
      this.emitProtectionChanged()
    }, BrowserController.PENDING_PRESENTATION_TTL_MS)
    this.pendingPresentationTimer.unref?.()
  }

  /** Request the existing sidebar, retaining the request across route changes. */
  present(partition: string) {
    const state = this.viewState(partition)
    if (!state) throw new Error(`no browser view for partition ${partition}`)
    this.touch(partition)
    const request = { id: ++this.presentationSequence, state }
    this.presentation = request
    const protectionBefore = this.protectedPageIDs()
    this.setPendingPresentation(partition)
    if (!sameProtection(protectionBefore, this.protectedPageIDs())) this.emitProtectionChanged()
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

  setShared(partition: string, shared: boolean) {
    const entry = this.views.get(partition)
    if (!entry) return
    entry.shared = shared
    this.emitState(partition)
  }

  /** Screenshot a view, working around the hidden-view frame starvation:
   * Page.captureScreenshot never resolves for a view whose rect lies fully
   * outside the window — the compositor has no frames to hand out. Hidden
   * views already park on a 1px sliver inside the window edge, so flipping
   * the transient flag and reconciling is all it takes to produce frames at
   * the parked layout size. (Live finding 2026-11-13: a transient show at
   * x=-32000 still hangs; a 1px onscreen sliver captures fine.) */
  async captureScreenshot(partition: string, fullPage: boolean) {
    const entry = this.views.get(partition)
    if (!entry) throw new Error(`no browser view for partition ${partition}`)
    this.touch(partition)
    const win = entry.win && !entry.win.isDestroyed() ? entry.win : undefined
    if (entry.visible || !win) return this.scaleScreenshot(await entry.cdp.screenshot(fullPage), entry)
    entry.transientShow = true
    this.reconcile(partition)
    log("screenshot", "transient parked show", { partition })
    try {
      // give the compositor a beat to start producing frames
      await new Promise((resolve) => setTimeout(resolve, 150))
      return this.scaleScreenshot(await entry.cdp.screenshot(fullPage), entry)
    } finally {
      entry.transientShow = false
      this.reconcile(partition)
    }
  }

  /** Page.captureScreenshot returns physical pixels (CSS px × device scale
   * factor). Downscale to the layout viewport so screenshots are a uniform
   * 1x regardless of the display's DPI — smaller for agents to read. */
  private scaleScreenshot(data: string, entry: ViewEntry) {
    const image = nativeImage.createFromBuffer(Buffer.from(data, "base64"))
    if (image.isEmpty()) return data
    const width = image.getSize().width
    const cssWidth = entry.appliedBounds?.width ?? entry.bounds?.width ?? DEFAULT_VIEWPORT.width
    if (!Number.isSafeInteger(width) || width <= cssWidth || cssWidth < 1) return data
    const scaled = image.resize({ width: cssWidth, quality: "good" })
    log("screenshot", `scaled width=${width} cssWidth=${cssWidth}`)
    return scaled.toPNG().toString("base64")
  }

  close(partition: string, reason = "close") {
    this.teardown(partition, reason)
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
    const wasProtected = this.protectedPageID === partition || this.pendingPresentationPageID === partition
    if (this.protectedPageID === partition) this.protectedPageID = undefined
    if (this.pendingPresentationPageID === partition) this.setPendingPresentation()
    const epoch = this.epochs.get(partition) ?? 0
    log("teardown", reason, { partition, epoch })
    for (const listener of this.viewClosedListeners) {
      try {
        listener(partition, epoch, entry.identity.profileID, reason)
      } catch (error) {
        log("teardown", "closed listener failed", { partition, reason, error: String(error) })
      }
    }
    if (wasProtected) this.emitProtectionChanged()
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
      if (entry.identity.kind === "consultation") continue
      if (entry.identity.kind !== "agent" && !partition.startsWith("agent-browser-")) continue // user views are never reaped
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
    if (this.pendingPresentationTimer) clearTimeout(this.pendingPresentationTimer)
    this.reapTimer = undefined
    this.pendingPresentationTimer = undefined
  }
}

// Session.fromPartition warm-up so the user partition exists before first use.
export function warmupBrowserSession(partition: string) {
  session.fromPartition(partition)
  log("session", "warm", { partition })
}

export const browserController = new BrowserController()
