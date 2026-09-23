import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { active } from "@/pages/session/session-working"

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

const pendingSubmissions = new Map<string, Map<string, Set<string>>>()
const statusRevisions = new Map<string, Map<string, number>>()

export function bumpSessionStatusRevision(directory: string, sessionID: string) {
  if (!directory || !sessionID) return
  let revisions = statusRevisions.get(directory)
  if (!revisions) statusRevisions.set(directory, (revisions = new Map()))
  revisions.set(sessionID, (revisions.get(sessionID) ?? 0) + 1)
}

export function sessionStatusRevisionSnapshot(directory: string) {
  return Object.fromEntries(statusRevisions.get(directory) ?? [])
}

export function sessionStatusValueSnapshot(statuses: Record<string, SessionStatus | undefined>) {
  return Object.fromEntries(Object.entries(statuses).map(([sessionID, status]) => [sessionID, JSON.stringify(status)]))
}

export function clearSessionStatusTracking(directory: string) {
  pendingSubmissions.delete(directory)
  statusRevisions.delete(directory)
}

export function setSessionStatusPending(directory: string, sessionID: string, pending: boolean, token = "default") {
  if (!directory || !sessionID) return
  let sessions = pendingSubmissions.get(directory)
  if (pending) {
    if (!sessions) pendingSubmissions.set(directory, (sessions = new Map()))
    let tokens = sessions.get(sessionID)
    if (!tokens) sessions.set(sessionID, (tokens = new Set()))
    tokens.add(token)
    console.debug(`[global-sync] optimistic submit pending directory=${directory} session=${sessionID} token=${token}`)
    return
  }
  const tokens = sessions?.get(sessionID)
  tokens?.delete(token)
  if (tokens?.size === 0) sessions?.delete(sessionID)
  if (sessions?.size === 0) pendingSubmissions.delete(directory)
  console.debug(
    `[global-sync] optimistic submit confirmed or cleared directory=${directory} session=${sessionID} token=${token}`,
  )
}

export function pendingSessionStatusIDs(directory: string) {
  return [...(pendingSubmissions.get(directory)?.keys() ?? [])]
}

export type SessionStatusRefreshReason = "bootstrap" | "server-connected" | "global-disposed" | "visibility" | "manual"

export function authoritativeSessionStatusMap(
  data: Record<string, SessionStatus> | null | undefined,
): Record<string, SessionStatus> {
  if (!data || typeof data !== "object") return {}
  return { ...data }
}

/**
 * A full status snapshot is authoritative. Pending user messages are not proof
 * of activity: they may outlive a detached worker process indefinitely.
 */
export function mergeSessionStatusRefresh(
  local: Record<string, SessionStatus | undefined>,
  remote: Record<string, SessionStatus> | null | undefined,
  _messages: Record<string, readonly Message[] | undefined>,
  pendingIDs: readonly string[] = [],
  requestStatuses: Record<string, string | undefined> = sessionStatusValueSnapshot(local),
  requestRevisions: Record<string, number> = {},
  currentRevisions: Record<string, number> = {},
): Record<string, SessionStatus> {
  const next = authoritativeSessionStatusMap(remote)
  const pending = new Set(pendingIDs)
  const staleBusy = Object.entries(local)
    .filter(([sessionID, status]) => status?.type === "busy" && next[sessionID] === undefined && pending.has(sessionID))
    .map(([sessionID, status]) => [sessionID, status] as const)
  for (const [sessionID, status] of staleBusy) next[sessionID] = status!
  const requestIDs = new Set([...Object.keys(requestStatuses), ...Object.keys(local)])
  for (const sessionID of requestIDs) {
    const changedDuringRequest = (currentRevisions[sessionID] ?? 0) > (requestRevisions[sessionID] ?? 0)
    if (!changedDuringRequest && requestStatuses[sessionID] === JSON.stringify(local[sessionID])) continue
    const status = local[sessionID]
    if (status) next[sessionID] = status
    else delete next[sessionID]
    console.debug(
      `[global-sync] status refresh kept newer local change session=${sessionID} revisionChanged=${String(changedDuringRequest)} current=${status?.type ?? "missing"}`,
    )
  }
  const cleared = Object.entries(local)
    .filter(
      ([sessionID, status]) => status?.type === "busy" && next[sessionID] === undefined && !pending.has(sessionID),
    )
    .map(([sessionID]) => sessionID)
  if (cleared.length) console.debug(`[global-sync] status snapshot cleared omitted busy sessions=${cleared.join(",")}`)
  return next
}

export function sessionsToReconcileOnStreamConnect(
  statuses: Record<string, SessionStatus | undefined>,
  _messages: Record<string, readonly Message[] | undefined>,
) {
  return Object.entries(statuses)
    .filter(([, status]) => status?.type === "busy")
    .map(([sessionID]) => sessionID)
}

export function sessionsToReconcileMessagesAfterStatusRefresh(
  previous: Record<string, SessionStatus | undefined>,
  next: Record<string, SessionStatus | undefined>,
  messages: Record<string, readonly Message[] | undefined>,
) {
  return Object.entries(previous)
    .filter(
      ([sessionID, status]) =>
        status?.type === "busy" && next[sessionID]?.type !== "busy" && active(messages[sessionID]) !== undefined,
    )
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
