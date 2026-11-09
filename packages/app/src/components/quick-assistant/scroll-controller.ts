import { createStore } from "solid-js/store"
import { untrack } from "solid-js"
import { createMessageNavigation } from "@/pages/session/message-navigation"
import { createLiveBottomFollow } from "@/pages/session/timeline/live-bottom"
import { createScrollLedger, type ScrollOrigin } from "@/pages/session/timeline/scroll-ledger"
import { atPhysicalBottom } from "@/pages/session/use-session-scroll-utils"
import { shouldMarkBoundaryGesture } from "@/pages/session/message-gesture"
import { createQuickAssistantReadingAnchor, type QuickAssistantReadingSnapshot } from "./reading-anchor"

type Direction = "up" | "down" | "other"
type Token = { sessionKey: string; generation: number; epoch: number }

export function createQuickAssistantScroll(
  options: {
    request?: (callback: FrameRequestCallback) => number
    cancel?: (id: number) => void
    observer?: (callback: () => void) => Pick<ResizeObserver, "observe" | "disconnect">
    log?: (message: string) => void
  } = {},
) {
  const [state, setState] = createStore({ version: 0, overflow: false })
  const debug = typeof window !== "undefined" && window.localStorage.getItem("opencode.session.lag.debug") === "1"
  const log = (message: string) => {
    options.log?.(message)
    if (!debug) return
    const target = window as Window & { __opencodeQuickScrollDebug?: string[] }
    const entries = (target.__opencodeQuickScrollDebug ??= [])
    entries.push(message)
    if (entries.length > 1000) entries.splice(0, entries.length - 1000)
    console.debug(message)
  }
  let root: HTMLDivElement | undefined
  let content: HTMLElement | undefined
  let visible = true
  let disposed = false
  let epoch = 0
  let displacement = 0
  let knownTop = 0
  let knownMaximum = 0
  let direction: Direction | undefined
  let saved: QuickAssistantReadingSnapshot | undefined
  let capturedGeometry = ""
  let pendingUpdates = 0
  let restoring = false
  let observer: Pick<ResizeObserver, "observe" | "disconnect"> | undefined
  let follow: ReturnType<typeof createLiveBottomFollow<HTMLDivElement>> | undefined
  const ledger = createScrollLedger()
  const navigation = createMessageNavigation({
    onChange: (next, previous) => {
      follow?.cancel("intent-change")
      if (next.generation !== previous.generation) {
        saved = undefined
        restoring = false
      }
      setState("version", (value) => value + 1)
      log(`[quick-assistant:scroll] intent=${next.target?.kind ?? "none"} generation=${next.generation}`)
    },
  })
  const token = (): Token => {
    const { sessionKey, generation } = navigation.state()
    return { sessionKey, generation, epoch }
  }
  const current = (value: Token) => value.epoch === epoch && navigation.current(value)
  const valid = () => !disposed && visible && !!root?.isConnected && root.clientHeight > 0
  const reading = () => navigation.state().reading
  const following = () => navigation.state().following
  const maximum = () => (root ? Math.max(0, root.scrollHeight - root.clientHeight) : 0)
  const applyPosition = (top: number, origin: ScrollOrigin, owner = token()) => {
    if (!valid() || !root || !current(owner)) return 0
    if ((origin === "bottom" || origin === "initial") && !following()) return 0
    if (origin === "layout" && !reading()) return 0
    const before = root.scrollTop
    root.scrollTop = Math.max(0, Math.min(maximum(), top))
    const after = root.scrollTop
    ledger.recordWrite(before, after, origin)
    if (after !== before)
      log(
        `[quick-assistant:scroll] write origin=${origin} session=${owner.sessionKey} generation=${owner.generation} epoch=${owner.epoch} mode=${following() ? "live" : "reading"} direction=${direction ?? "none"} before=${before} after=${after}`,
      )
    knownTop = after
    knownMaximum = maximum()
    return after - before
  }
  const anchor = createQuickAssistantReadingAnchor({
    viewport: () => (valid() ? root : undefined),
    reading,
    userDisplacement: () => displacement,
    write: (_root, top) => applyPosition(top, "layout"),
    log,
  })
  const geometry = () =>
    root ? `${root.scrollHeight}/${root.clientHeight}/${root.clientWidth}/${content?.offsetHeight ?? 0}` : ""
  const capture = () => {
    if (!valid() || !reading() || restoring) return
    saved = anchor.snapshot() ?? saved
    capturedGeometry = geometry()
  }
  const observe = (refresh = true) => {
    if (!valid() || !root) return
    const max = maximum()
    // Native height clamps are layout motion, not user input.
    if (max < knownMaximum && knownTop > max && root.scrollTop === max) ledger.recordWrite(knownTop, max, "layout")
    const motion = ledger.observe(root.scrollTop, { user: direction !== undefined })
    if (motion.displacement || motion.compensationDelta)
      log(
        `[quick-assistant:scroll] observe mode=${following() ? "live" : "reading"} direction=${direction ?? "none"} top=${root.scrollTop} user=${motion.userDisplacement} system=${motion.compensationDelta} displacement=${displacement}`,
      )
    knownTop = root.scrollTop
    knownMaximum = max
    // Net physical motion must survive even without wheel/touch provenance (for
    // example native selection scrolling). Provenance only changes intent.
    displacement += motion.userDisplacement
    if (direction !== undefined && Math.abs(motion.userDisplacement) > 0.01) {
      if (motion.userDisplacement < 0) navigation.userInput({ direction: "up", atBottom: false })
      if (direction === "down" && motion.userDisplacement > 0 && atPhysicalBottom(root)) {
        navigation.observeUserMotion({ direction: "down", atBottom: true })
        if (following()) follow?.follow()
      }
    }
    if (reading() && refresh && !pendingUpdates && capturedGeometry === geometry()) capture()
    setState("overflow", max > 1)
  }
  follow = createLiveBottomFollow<HTMLDivElement>({
    root: () => (valid() ? root : undefined),
    enabled: () => valid() && following(),
    write: (_root, top) => applyPosition(top, "bottom"),
    request: options.request,
    cancel: options.cancel,
    log,
  })
  const restore = () => {
    if (!valid()) return
    observe(false)
    if (reading()) {
      if (saved && restoring && !anchor.available(saved)) return
      anchor.restoreSnapshot(saved)
      restoring = false
      capture()
    } else if (following()) follow?.follow()
  }
  const layout = () => {
    if (!valid()) return
    if (following()) {
      observe(false)
      follow?.follow()
    } else if (!pendingUpdates) restore()
  }
  const reconnectObserver = () => {
    observer?.disconnect()
    if (!root) return
    const binding = epoch
    const callback = () => {
      if (binding === epoch) layout()
    }
    observer =
      options.observer?.(callback) ?? (typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(callback))
    observer?.observe(root)
    if (content) observer?.observe(content)
  }
  const bind = (node: HTMLDivElement | undefined) => {
    if (root === node) return
    if (!pendingUpdates && (!saved || capturedGeometry === geometry())) capture()
    follow?.cancel("root-change")
    observer?.disconnect()
    epoch++
    pendingUpdates = 0
    root = node
    restoring = !!saved && reading()
    direction = undefined
    knownTop = node?.scrollTop ?? 0
    knownMaximum = maximum()
    ledger.reset(knownTop)
    reconnectObserver()
    layout()
  }
  const input = (delta: number, target?: EventTarget | null) => {
    if (!valid() || !root || !delta) return
    const element = target instanceof Element ? target : undefined
    const nested = element?.closest<HTMLElement>("[data-scrollable]")
    if (
      nested &&
      nested !== root &&
      root.contains(nested) &&
      !shouldMarkBoundaryGesture({
        delta,
        scrollTop: nested.scrollTop,
        scrollHeight: nested.scrollHeight,
        clientHeight: nested.clientHeight,
      })
    )
      return
    observe()
    direction = delta < 0 ? "up" : "down"
    if (delta < 0) {
      navigation.userInput({ direction: "up", atBottom: false })
      follow?.cancel("user-input")
      if (!pendingUpdates && (!saved || capturedGeometry === geometry())) capture()
    }
  }
  navigation.reset("", "")
  navigation.requestFollowing()
  return {
    following: () => {
      state.version
      return following()
    },
    reading: () => {
      state.version
      return reading()
    },
    overflow: () => state.overflow,
    active: () => follow?.active() ?? false,
    bind,
    content(node: HTMLElement | undefined) {
      content = node
      reconnectObserver()
      untrack(layout)
    },
    session(key: string) {
      if (navigation.state().sessionKey === key) return
      follow?.cancel("session-change")
      epoch++
      saved = undefined
      restoring = false
      capturedGeometry = ""
      pendingUpdates = 0
      displacement = 0
      direction = undefined
      navigation.reset(key, "")
      navigation.requestFollowing()
      ledger.reset(root?.scrollTop ?? 0)
      knownTop = root?.scrollTop ?? 0
      knownMaximum = maximum()
      reconnectObserver()
      untrack(layout)
    },
    visible(value: boolean) {
      if (visible === value) return
      if (!pendingUpdates && (!saved || capturedGeometry === geometry())) capture()
      visible = value
      epoch++
      pendingUpdates = 0
      direction = undefined
      follow?.cancel("visibility")
      reconnectObserver()
      if (value) {
        ledger.reset(root?.scrollTop ?? 0)
        knownTop = root?.scrollTop ?? 0
        knownMaximum = maximum()
        untrack(layout)
      }
    },
    input,
    takeover() {
      if (!valid()) return
      observe()
      navigation.requestReading()
      follow?.cancel("reading")
      capture()
    },
    scroll: observe,
    endInput: () => {
      observe()
      direction = undefined
    },
    position(top: number, delta: number) {
      input(delta)
      if (!direction) direction = "other"
      applyPosition(top, "user")
      observe()
    },
    resume() {
      navigation.requestFollowing()
      saved = undefined
      direction = undefined
      follow?.follow()
    },
    layout,
    beforeUpdate(node: HTMLElement) {
      if (!valid() || !root?.contains(node)) return () => {}
      observe()
      const owner = token()
      const snapshot = reading() && (!saved || capturedGeometry === geometry()) ? anchor.snapshot() : undefined
      if (!pendingUpdates && snapshot) saved = snapshot
      pendingUpdates++
      let committed = false
      return () => {
        if (committed) return
        committed = true
        if (owner.epoch !== epoch) return
        pendingUpdates = Math.max(0, pendingUpdates - 1)
        if (!current(owner) || !valid()) {
          if (!pendingUpdates) layout()
          return
        }
        if (!pendingUpdates) restore()
      }
    },
    dispose() {
      disposed = true
      epoch++
      follow?.cancel("cleanup")
      observer?.disconnect()
      root = undefined
      content = undefined
      saved = undefined
    },
  }
}

export type QuickAssistantScroll = ReturnType<typeof createQuickAssistantScroll>
