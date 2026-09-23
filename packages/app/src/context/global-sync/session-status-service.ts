import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { reconcile } from "solid-js/store"
import {
  clearSessionStatusTracking,
  mergeSessionStatusRefresh,
  pendingSessionStatusIDs,
  sessionsToReconcileMessagesAfterStatusRefresh,
  sessionStatusRevisionSnapshot,
  sessionStatusValueSnapshot,
  bumpSessionStatusRevision,
  setSessionStatusPending,
  type SessionStatusRefreshReason,
} from "./session-status-refresh"
import type { SessionControllerDeps } from "./session-service-types"

export function createSessionStatusService(deps: SessionControllerDeps) {
  const inflight = new Map<string, Promise<void>>()

  const get = (directory: string, sessionID: string) => {
    if (!deps.key(directory) || !sessionID) return
    return deps.child(directory)[0].session_status[sessionID]
  }

  const all = (directory: string) => {
    if (!deps.key(directory)) return {} as Record<string, SessionStatus | undefined>
    return deps.child(directory)[0].session_status
  }

  const refresh = async (directory: string, reason: SessionStatusRefreshReason = "manual") => {
    const key = deps.key(directory)
    if (!key || deps.isolated(directory)) return
    const pending = inflight.get(key)
    if (pending) return pending

    deps.pin(directory)
    const child = deps.child(directory)
    const revision = deps.revision(directory)
    const statusAtStart = sessionStatusValueSnapshot(child[0].session_status)
    const revisionsAtStart = sessionStatusRevisionSnapshot(directory)
    console.debug(`[global-sync] session-status refresh directory=${directory} reason=${reason}`)
    const promise = deps
      .sdk(directory)
      .session.status()
      .then(async (response) => {
        if (!deps.current(directory, child, revision)) return
        const previous = { ...child[0].session_status }
        const next = mergeSessionStatusRefresh(
          child[0].session_status,
          response.data,
          child[0].message,
          pendingSessionStatusIDs(directory),
          statusAtStart,
          revisionsAtStart,
          sessionStatusRevisionSnapshot(directory),
        )
        const transcripts = sessionsToReconcileMessagesAfterStatusRefresh(previous, next, child[0].message)
        child[1]("session_status", reconcile(next))
        if (!deps.reconcileMessages) return
        await Promise.all(
          transcripts.map(async (sessionID) => {
            console.debug(
              `[global-sync] stale assistant transcript reconcile start directory=${directory} session=${sessionID}`,
            )
            try {
              await deps.reconcileMessages!(directory, sessionID)
              console.debug(
                `[global-sync] stale assistant transcript reconcile finish directory=${directory} session=${sessionID}`,
              )
            } catch (error) {
              console.debug(
                `[global-sync] stale assistant transcript reconcile failed directory=${directory} session=${sessionID} err=${error instanceof Error ? error.message : String(error)}`,
              )
            }
          }),
        )
      })
      .catch((error) => {
        console.debug(
          `[global-sync] refresh session status failed directory=${directory} reason=${reason} err=${error instanceof Error ? error.message : String(error)}`,
        )
      })
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key)
        deps.unpin(directory)
      })
    inflight.set(key, promise)
    return promise
  }

  return {
    get,
    all,
    set(directory: string, sessionID: string, status: SessionStatus) {
      bumpSessionStatusRevision(directory, sessionID)
      deps.child(directory)[1]("session_status", sessionID, reconcile(status))
    },
    refresh,
    clearDirectory(directory: string) {
      inflight.delete(deps.key(directory))
      clearSessionStatusTracking(directory)
    },
    inspect() {
      return { inflight: inflight.size }
    },
  }
}
