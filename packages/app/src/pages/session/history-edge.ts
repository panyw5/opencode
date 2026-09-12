/**
 * Pure policy for requesting older session history at the top of a timeline.
 * It deliberately does not know about rendering, scroll events, or pagination
 * results (those belong to session-history-pagination).
 */

export type HistoryInput = {
  cursor?: string | null
  delta?: number
  top?: number
  time?: number
  gestureId?: string | number
  kind?: "wheel" | "touch" | "keyboard" | "other"
  /** Use for a browser edge signal whose delta is zero but is known outward. */
  outward?: boolean
}

export type HistoryPosition = {
  top: number
  time?: number
  cursor?: string | null
}

export type HistoryLoadEnd = {
  result: "success" | "failed" | "stalled" | "complete"
  cursor?: string | null
}

export type HistoryEdgeDecision = {
  shouldRequest: boolean
  reason: "eligible" | "top-not-outward" | "navigation-landing" | "in-flight" | "duplicate" | "blocked" | "complete"
}

type Options = {
  now?: () => number
  topThreshold?: number
  gestureWindowMs?: number
  debug?: (event: string, details: Record<string, unknown>) => void
}

const DEFAULT_GESTURE_WINDOW = 140

export function createHistoryEdgeController(options: Options = {}) {
  const now = options.now ?? (() => Date.now())
  const threshold = options.topThreshold ?? 1
  const gestureWindow = options.gestureWindowMs ?? DEFAULT_GESTURE_WINDOW
  const debug = options.debug ?? (() => {})

  let cursor: string | null = null
  let atTop = false
  let navigationLanding = false
  let inFlight = false
  let loadGesture: string | undefined
  let complete = false
  let sequence = 0
  let activeGesture: string
  let lastInputAt = -Infinity
  let lastOutward = false
  const requested = new Set<string>()
  const blocked = new Set<string>()
  const completedGestures = new Set<string>()

  const log = (event: string, details: Record<string, unknown> = {}) =>
    debug(event, { ...details, cursor, inFlight, atTop })
  const keyFor = (gesture: string, requestedCursor: string | null) => `${gesture}\u0000${requestedCursor ?? "<start>"}`
  const resolveGesture = (input: HistoryInput) => {
    const time = input.time ?? now()
    if (input.gestureId !== undefined) {
      activeGesture = String(input.gestureId)
      lastInputAt = time
      return activeGesture
    }
    if (!activeGesture || time - lastInputAt > gestureWindow) {
      sequence += 1
      activeGesture = `${input.kind ?? "input"}-${sequence}`
    }
    lastInputAt = time
    return activeGesture
  }
  const decision = (input: { gesture: string; outward: boolean }): HistoryEdgeDecision => {
    const key = keyFor(input.gesture, cursor)
    if (!input.outward) return { shouldRequest: false, reason: "top-not-outward" }
    if (navigationLanding) return { shouldRequest: false, reason: "navigation-landing" }
    if (!atTop) return { shouldRequest: false, reason: "top-not-outward" }
    if (complete) return { shouldRequest: false, reason: "complete" }
    if (inFlight) return { shouldRequest: false, reason: "in-flight" }
    if (blocked.has(input.gesture)) return { shouldRequest: false, reason: "blocked" }
    if (completedGestures.has(input.gesture)) return { shouldRequest: false, reason: "duplicate" }
    if (requested.has(key)) return { shouldRequest: false, reason: "duplicate" }
    requested.add(key)
    if (requested.size > 128) requested.delete(requested.values().next().value!)
    log("request-eligible", { gesture: input.gesture, key })
    return { shouldRequest: true, reason: "eligible" }
  }

  return {
    noteUserInput(input: HistoryInput): HistoryEdgeDecision {
      if (input.cursor !== undefined) cursor = input.cursor
      const gesture = resolveGesture(input)
      // Only a real input may leave the navigation landing guard.
      navigationLanding = false
      const top = input.top
      if (top !== undefined) atTop = top <= threshold
      const outward = input.outward ?? (input.delta === 0 ? input.kind === "keyboard" : (input.delta ?? 0) < 0)
      lastOutward = outward
      if (input.delta === 0 && !input.outward && input.kind !== "keyboard") {
        log("zero-input-not-explicit", { gesture, kind: input.kind })
        return { shouldRequest: false, reason: "top-not-outward" }
      }
      if (input.delta === 0 && (input.top ?? (atTop ? 0 : 1)) > threshold) {
        log("input-not-at-top", { gesture, delta: input.delta, top })
        return { shouldRequest: false, reason: "top-not-outward" }
      }
      log("user-input", { gesture, delta: input.delta, top, kind: input.kind })
      return decision({ gesture, outward })
    },

    observePosition(position: HistoryPosition): HistoryEdgeDecision {
      if (position.cursor !== undefined) cursor = position.cursor
      atTop = position.top <= threshold
      if (navigationLanding) return { shouldRequest: false, reason: "navigation-landing" }
      // A passive scroll event cannot create an exploration gesture.
      if (!activeGesture) return { shouldRequest: false, reason: "top-not-outward" }
      if (now() - lastInputAt > gestureWindow || !lastOutward) {
        log("position-not-active-outward", { gesture: activeGesture, age: now() - lastInputAt })
        return { shouldRequest: false, reason: "top-not-outward" }
      }
      log("position-observed", { top: position.top, gesture: activeGesture })
      return decision({ gesture: activeGesture, outward: true })
    },

    beginLoad(): boolean {
      if (inFlight) return false
      inFlight = true
      loadGesture = activeGesture
      log("load-begin")
      return true
    },

    endLoad(input: HistoryLoadEnd): void {
      inFlight = false
      if (input.cursor !== undefined) cursor = input.cursor
      if (input.result === "failed" || input.result === "stalled") {
        if (loadGesture) blocked.add(loadGesture)
        if (blocked.size > 64) blocked.delete(blocked.values().next().value!)
      }
      if (input.result === "success" || input.result === "complete") {
        if (loadGesture) completedGestures.add(loadGesture)
      }
      if (completedGestures.size > 64) completedGestures.delete(completedGestures.values().next().value!)
      if (input.result === "complete" || input.cursor === null) complete = true
      log("load-end", { result: input.result, nextCursor: input.cursor })
      loadGesture = undefined
    },

    reset(input: { navigation?: boolean; cursor?: string | null } = {}): void {
      cursor = input.cursor ?? null
      atTop = false
      navigationLanding = input.navigation === true
      inFlight = false
      loadGesture = undefined
      complete = false
      activeGesture = ""
      lastInputAt = -Infinity
      lastOutward = false
      requested.clear()
      blocked.clear()
      completedGestures.clear()
      log("reset", { navigation: navigationLanding })
    },

    /** Marks the end of the navigation landing phase without creating input. */
    endNavigationLanding(): void {
      navigationLanding = false
      log("navigation-landing-end")
    },

    state(): { cursor: string | null; inFlight: boolean; atTop: boolean; navigationLanding: boolean } {
      return { cursor, inFlight, atTop, navigationLanding }
    },
  }
}

export type HistoryEdgeController = ReturnType<typeof createHistoryEdgeController>
