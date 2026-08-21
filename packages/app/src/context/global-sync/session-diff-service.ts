import type { SnapshotFileDiff as FileDiff } from "@opencode-ai/sdk/v2"
import { retry } from "@opencode-ai/core/util/retry"
import { reconcile } from "solid-js/store"
import type { SessionControllerDeps } from "./session-service-types"

export function createSessionDiffService(deps: SessionControllerDeps) {
  const inflight = new Map<string, Promise<FileDiff[] | undefined>>()
  const revision = new Map<string, number>()
  const keyFor = (directory: string, sessionID: string) => `${deps.canonical(directory)}\n${sessionID}`
  const rev = (directory: string, sessionID: string) => revision.get(keyFor(directory, sessionID)) ?? 0
  const bump = (directory: string, sessionID: string) => {
    const key = keyFor(directory, sessionID)
    revision.set(key, (revision.get(key) ?? 0) + 1)
  }

  const get = (directory: string, sessionID: string) => {
    directory = deps.canonical(directory)
    return deps.child(directory)[0].session_diff[sessionID]
  }

  const load = (directory: string, sessionID: string, force = false) => {
    directory = deps.canonical(directory)
    const child = deps.child(directory)
    const existing = child[0].session_diff[sessionID]
    if (existing !== undefined && !force) return Promise.resolve(existing)
    const key = keyFor(directory, sessionID)
    const pending = inflight.get(key)
    if (pending) return pending
    const directoryRevision = deps.revision(directory)
    const eventRevision = rev(directory, sessionID)
    const promise = retry(() => deps.sdk(directory).session.diff({ sessionID }))
      .then((response) => {
        if (!deps.current(directory, child, directoryRevision)) return
        if (rev(directory, sessionID) !== eventRevision) return child[0].session_diff[sessionID]
        const list = response.data ?? []
        child[1]("session_diff", sessionID, reconcile(list, { key: "file" }))
        return list
      })
      .finally(() => {
        const current = inflight.get(key)
        if (current && current !== promise) return
        if (current === promise) inflight.delete(key)
        if (!inflight.has(key)) revision.delete(key)
      })
    inflight.set(key, promise)
    return promise
  }

  return {
    get,
    ensure(directory: string, sessionID: string) {
      return load(directory, sessionID)
    },
    refresh(directory: string, sessionID: string) {
      return load(directory, sessionID, true)
    },
    event: bump,
    clear(directory: string, sessionIDs: string[]) {
      directory = deps.canonical(directory)
      for (const sessionID of sessionIDs) {
        const key = keyFor(directory, sessionID)
        const pending = inflight.get(key)
        bump(directory, sessionID)
        inflight.delete(key)
        if (!pending) revision.delete(key)
      }
    },
    clearDirectory(directory: string) {
      const prefix = `${deps.canonical(directory)}\n`
      for (const key of inflight.keys()) {
        if (key.startsWith(prefix)) inflight.delete(key)
      }
      for (const key of revision.keys()) {
        if (key.startsWith(prefix)) revision.delete(key)
      }
    },
    inspect() {
      return { inflight: inflight.size, revision: revision.size }
    },
  }
}
