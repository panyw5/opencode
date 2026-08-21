import { Binary } from "@opencode-ai/core/util/binary"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { reconcile } from "solid-js/store"
import {
  clearSessionInfoDirectory,
  clearSessionInfoLoads,
  clearSessionInfos,
  loadSessionInfo,
  resolveSessionInfoCommit,
} from "./session-info-load"
import type { SessionControllerDeps } from "./session-service-types"

export function createSessionInfoService(deps: SessionControllerDeps) {
  const get = (directory: string, sessionID: string) => {
    directory = deps.canonical(directory)
    if (!directory || !sessionID) return
    const [store] = deps.child(directory)
    const match = Binary.search(store.session, sessionID, (session) => session.id)
    return match.found ? store.session[match.index] : undefined
  }

  const load = async (directory: string, sessionID: string, force = false): Promise<Session | undefined> => {
    directory = deps.canonical(directory)
    if (!directory || !sessionID || deps.isolated(directory)) return
    const cached = get(directory, sessionID)
    if (cached && !force) return cached

    deps.pin(directory)
    const child = deps.child(directory)
    const revision = deps.revision(directory)
    try {
      const value = await loadSessionInfo({
        directory,
        sessionID,
        load: async () => (await deps.sdk(directory).session.get({ sessionID })).data,
      })
      if (!value || !deps.current(directory, child, revision)) return

      const current = get(directory, sessionID)
      const nextValue = resolveSessionInfoCommit(current, value)
      if (nextValue === current) return current
      const result = Binary.search(child[0].session, nextValue.id, (session) => session.id)
      if (result.found) {
        child[1]("session", result.index, reconcile(nextValue))
        return nextValue
      }
      const next = child[0].session.slice()
      next.splice(result.index, 0, nextValue)
      child[1]("session", reconcile(next, { key: "id" }))
      return nextValue
    } finally {
      deps.unpin(directory)
    }
  }

  return {
    get,
    ensure(directory: string, sessionID: string) {
      return load(directory, sessionID)
    },
    refresh(directory: string, sessionID: string) {
      return load(directory, sessionID, true)
    },
    clear: clearSessionInfos,
    clearDirectory: clearSessionInfoDirectory,
    clearDomain: clearSessionInfoLoads,
  }
}
