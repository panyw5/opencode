import type { Part } from "@opencode-ai/sdk/v2"

export type ToolHydrationKind = "user" | "viewport"

/**
 * Which tool parts have been hydrated past the skeleton placeholder.
 * - "user": opened by interaction (pointer/keyboard/reactive) — kept forever
 *   so a scroll-away can never revert a card the user touched.
 * - "viewport": hydrated because the card approached the viewport — released
 *   on unmount so remounts start from the cheap placeholder again.
 */
const hydrationKind = new Map<string, ToolHydrationKind>()

export function toolHydrationKey(sessionID: string, partID: string) {
  return `${sessionID}\n${partID}`
}

export function isToolPartHydrated(key: string) {
  return hydrationKind.has(key)
}

export function markToolPartHydrated(key: string, kind: ToolHydrationKind) {
  if (kind === "user") {
    hydrationKind.set(key, "user")
    return
  }
  if (hydrationKind.get(key) !== "user") hydrationKind.set(key, "viewport")
}

/** Viewport-only hydration is dropped on unmount; user-opened marks stay. */
export function releaseToolPartHydration(key: string) {
  if (hydrationKind.get(key) === "viewport") hydrationKind.delete(key)
}

export function clearToolPartHydration(sessionID?: string) {
  if (!sessionID) {
    hydrationKind.clear()
    return
  }
  const prefix = `${sessionID}\n`
  for (const key of [...hydrationKind.keys()]) {
    if (key.startsWith(prefix)) hydrationKind.delete(key)
  }
}

/** Collapsed completed tools can use a same-height shell; live/open tools must render fully. */
export function shouldDeferToolPart(part: Part, defaultOpen?: boolean) {
  if (part.type !== "tool") return false
  if (defaultOpen) return false
  const status = part.state.status
  if (status === "pending" || status === "running") return false
  return true
}

// --- Viewport-driven hydration -------------------------------------------------
// One shared IntersectionObserver hydrates placeholders as they approach the
// viewport; per-instance observers would multiply connection overhead in
// tool-dense timelines.

let sharedViewportObserver: IntersectionObserver | undefined
const viewportCallbacks = new Map<Element, () => void>()

function viewportHydrationObserver() {
  if (!sharedViewportObserver) {
    sharedViewportObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const callback = viewportCallbacks.get(entry.target)
          if (callback) callback()
        }
      },
      // Start hydrating slightly before the card scrolls into view so the
      // swap (same box height) is finished by the time it is visible.
      { rootMargin: "300px" },
    )
  }
  return sharedViewportObserver
}

export function observeToolPartViewport(element: Element, onVisible: () => void) {
  const observer = viewportHydrationObserver()
  viewportCallbacks.set(element, onVisible)
  observer.observe(element)
  return () => {
    viewportCallbacks.delete(element)
    observer.unobserve(element)
  }
}
