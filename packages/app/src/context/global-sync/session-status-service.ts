import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { reconcile } from "solid-js/store"
import { mergeSessionStatusRefresh, type SessionStatusRefreshReason } from "./session-status-refresh"
import type { SessionControllerDeps } from "./session-service-types"

export function createSessionStatusService(deps: SessionControllerDeps) {
  const inflight = new Map<string, Promise<void>>()

  const get = (directory: string, sessionID: string) => {
    directory = deps.canonical(directory)
    if (!directory || !sessionID) return
    return deps.child(directory)[0].session_status[sessionID]
  }

  const all = (directory: string) => {
    directory = deps.canonical(directory)
    if (!directory) return {} as Record<string, SessionStatus | undefined>
    return deps.child(directory)[0].session_status
  }

  const refresh = async (directory: string, reason: SessionStatusRefreshReason = "manual") => {
    directory = deps.canonical(directory)
    if (!directory || deps.isolated(directory)) return
    const pending = inflight.get(directory)
    if (pending) return pending

    deps.pin(directory)
    const child = deps.child(directory)
    const revision = deps.revision(directory)
    console.debug(`[global-sync] session-status refresh directory=${directory} reason=${reason}`)
    const promise = deps
      .sdk(directory)
      .session.status()
      .then((response) => {
        if (!deps.current(directory, child, revision)) return
        child[1](
          "session_status",
          reconcile(mergeSessionStatusRefresh(child[0].session_status, response.data, child[0].message)),
        )
      })
      .catch((error) => {
        console.debug(
          `[global-sync] refresh session status failed directory=${directory} reason=${reason} err=${error instanceof Error ? error.message : String(error)}`,
        )
      })
      .finally(() => {
        if (inflight.get(directory) === promise) inflight.delete(directory)
        deps.unpin(directory)
      })
    inflight.set(directory, promise)
    return promise
  }

  return {
    get,
    all,
    set(directory: string, sessionID: string, status: SessionStatus) {
      directory = deps.canonical(directory)
      deps.child(directory)[1]("session_status", sessionID, reconcile(status))
    },
    refresh,
    clearDirectory(directory: string) {
      inflight.delete(deps.canonical(directory))
    },
    inspect() {
      return { inflight: inflight.size }
    },
  }
}
