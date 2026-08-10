import type { Part } from "@opencode-ai/sdk/v2"

const hydratedKeys = new Set<string>()

export function toolHydrationKey(sessionID: string, partID: string) {
  return `${sessionID}\n${partID}`
}

export function isToolPartHydrated(key: string) {
  return hydratedKeys.has(key)
}

export function markToolPartHydrated(key: string) {
  hydratedKeys.add(key)
}

export function clearToolPartHydration(sessionID?: string) {
  if (!sessionID) {
    hydratedKeys.clear()
    return
  }
  const prefix = `${sessionID}\n`
  for (const key of [...hydratedKeys]) {
    if (key.startsWith(prefix)) hydratedKeys.delete(key)
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

export function scheduleIdleHydrate(cb: () => void, timeout = 1200) {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(() => cb(), { timeout })
    return () => cancelIdleCallback(id)
  }
  const id = window.setTimeout(cb, 48)
  return () => clearTimeout(id)
}
