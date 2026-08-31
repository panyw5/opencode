import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { working } from "@/pages/session/session-working"

/**
 * Session-status full-table refresh is a **reconciliation** tool, not a heartbeat.
 *
 * Activate only on trust-boundary events where the local map may diverge from the server:
 * - directory bootstrap / app start
 * - backend reload / server.connected / event-bus reconnect (via bootstrap refresh)
 * - tab returns to foreground after a long background period
 * - explicit manual resync (if wired later)
 *
 * Do **not** poll while sessions are busy — live updates come from `session.status` events.
 */

/** Minimum time hidden before a visibility restore triggers a status snapshot. */
export const SESSION_STATUS_VISIBILITY_REFRESH_MS = 60_000

export type SessionStatusRefreshReason =
  | "bootstrap"
  | "server-connected"
  | "global-disposed"
  | "visibility"
  | "manual"

export function authoritativeSessionStatusMap(
  data: Record<string, SessionStatus> | null | undefined,
): Record<string, SessionStatus> {
  if (!data || typeof data !== "object") return {}
  return { ...data }
}

/**
 * Merge a full status snapshot from the server without wiping optimistic busy
 * that was set locally while the request is still in flight (server list still idle).
 */
export function mergeSessionStatusRefresh(
  local: Record<string, SessionStatus | undefined>,
  remote: Record<string, SessionStatus> | null | undefined,
  messages: Record<string, readonly Message[] | undefined>,
): Record<string, SessionStatus> {
  const next = authoritativeSessionStatusMap(remote)
  for (const [sessionID, status] of Object.entries(local)) {
    if (!status || status.type !== "busy") continue
    if (next[sessionID]) continue
    // Server omitted this session ⇒ idle. Keep local busy only while work still looks pending
    // (e.g. optimistic user message with no completed assistant yet).
    if (working(status, messages[sessionID])) next[sessionID] = status
  }
  return next
}

export function sessionsToReconcileOnStreamConnect(
  statuses: Record<string, SessionStatus | undefined>,
  messages: Record<string, readonly Message[] | undefined>,
) {
  return Object.entries(statuses)
    .filter(([sessionID, status]) => status?.type === "busy" && messages[sessionID] !== undefined)
    .map(([sessionID]) => sessionID)
}

export function sessionToReconcileOnStatusEvent(
  event: { type: string; properties?: unknown },
  statuses: Record<string, SessionStatus | undefined>,
) {
  if (event.type !== "session.status") return
  const properties = event.properties as { sessionID?: string; status?: { type?: string } } | undefined
  if (!properties?.sessionID || properties.status?.type !== "idle") return
  if (statuses[properties.sessionID]?.type !== "busy") return
  return properties.sessionID
}

/** Whether a visibility restore should pull a status snapshot after backgrounding. */
export function shouldRefreshSessionStatusOnVisibility(
  hiddenMs: number,
  thresholdMs = SESSION_STATUS_VISIBILITY_REFRESH_MS,
) {
  return hiddenMs >= thresholdMs
}

/** Boundary reasons that justify a full-table status pull (not event-driven busy/idle). */
export function isSessionStatusRefreshBoundary(reason: SessionStatusRefreshReason) {
  return (
    reason === "bootstrap" ||
    reason === "server-connected" ||
    reason === "global-disposed" ||
    reason === "visibility" ||
    reason === "manual"
  )
}
