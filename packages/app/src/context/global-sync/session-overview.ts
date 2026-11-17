import type { SessionOverviewResponse } from "@opencode-ai/sdk/v2/client"
import type { SessionControllerDeps } from "./session-service-types"

// The overview endpoint always fetches the canonical first page size. Callers
// needing a different limit or a `before` cursor use the plain messages route.
export const SESSION_OVERVIEW_PAGE_LIMIT = 80
const RESOLVED_TTL_MS = 2_000

/**
 * Shares one `/session/{id}/overview` response across the per-slice services
 * (messages first page, info, todo, children, user-message-index). The first
 * caller triggers the request; later callers attach while it is in flight or
 * reuse the resolved payload for a short window — the slices are loaded once
 * per session open anyway, so a couple seconds of reuse is fresher than the
 * staggered per-endpoint fetches it replaces.
 *
 * Force/authoritative callers use `pending()`/`load({fresh})` so they only join
 * a genuinely in-flight request and never replay a resolved snapshot.
 */
export function createSessionOverviewCache(deps: Pick<SessionControllerDeps, "key" | "sdk">) {
  const inflight = new Map<string, Promise<SessionOverviewResponse>>()
  const resolved = new Map<string, { at: number; value: SessionOverviewResponse }>()
  const keyFor = (directory: string, sessionID: string) => `${deps.key(directory)}\n${sessionID}`

  const pending = (directory: string, sessionID: string) => inflight.get(keyFor(directory, sessionID))

  const current = (directory: string, sessionID: string): Promise<SessionOverviewResponse> | undefined => {
    const inFlight = pending(directory, sessionID)
    if (inFlight) return inFlight
    const key = keyFor(directory, sessionID)
    const hit = resolved.get(key)
    if (!hit) return
    if (performance.now() - hit.at < RESOLVED_TTL_MS) return Promise.resolve(hit.value)
    resolved.delete(key)
    return
  }

  const load = (
    directory: string,
    sessionID: string,
    opts?: { fresh?: boolean },
  ): Promise<SessionOverviewResponse> => {
    const hit = opts?.fresh ? pending(directory, sessionID) : current(directory, sessionID)
    if (hit) return hit
    const key = keyFor(directory, sessionID)
    const promise = deps
      .sdk(directory)
      .session.overview({ sessionID, limit: String(SESSION_OVERVIEW_PAGE_LIMIT) })
      .then((response) => {
        if (!response.data) throw new Error("Session overview returned no data")
        return response.data
      })
    promise
      .then((value) => resolved.set(key, { at: performance.now(), value }))
      .catch(() => {})
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key)
      })
    inflight.set(key, promise)
    return promise
  }

  const clear = (directory: string, sessionIDs: string[]) => {
    for (const sessionID of sessionIDs) {
      const key = keyFor(directory, sessionID)
      inflight.delete(key)
      resolved.delete(key)
    }
  }

  const clearDirectory = (directory: string) => {
    const prefix = `${deps.key(directory)}\n`
    for (const map of [inflight, resolved] as const) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) map.delete(key)
      }
    }
  }

  return { load, current, pending, clear, clearDirectory }
}

export type SessionOverviewCache = ReturnType<typeof createSessionOverviewCache>
