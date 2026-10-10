import type { UserMessageIndexItem } from "@opencode-ai/sdk/v2/client"
import { createStore, produce } from "solid-js/store"

type IndexDeps = {
  key(directory: string, sessionID: string): string
  version(): number
  current(directory: string): boolean
  load(directory: string, sessionID: string): Promise<{ data?: UserMessageIndexItem[] }>
}

export function createSessionUserMessageIndex(deps: IndexDeps) {
  const requests = new Map<string, { promise: Promise<void>; removed: Set<string> }>()
  const [state, setState] = createStore({
    items: {} as Record<string, UserMessageIndexItem[] | undefined>,
    loading: {} as Record<string, boolean | undefined>,
    failed: {} as Record<string, boolean | undefined>,
  })

  const ensure = (directory: string, sessionID: string, options?: { force?: boolean }): Promise<void> => {
    const key = deps.key(directory, sessionID)
    if (!options?.force && state.items[key] !== undefined) return Promise.resolve()
    const existing = requests.get(key)
    if (existing) return existing.promise
    const version = deps.version()
    const removed = new Set<string>()
    setState("loading", key, true)
    setState("failed", key, false)
    console.debug(`[user-message-index] load-start directory=${directory} sid=${sessionID} version=${version}`)
    const current = () =>
      requests.get(key)?.promise === promise && deps.version() === version && deps.current(directory)
    const promise = Promise.resolve()
      .then(() => deps.load(directory, sessionID))
      .then((response) => {
        if (!current()) {
          console.debug(
            `[user-message-index] discard directory=${directory} sid=${sessionID} reason=invalidated-request`,
          )
          return
        }
        // Deletions must also be remembered before the first snapshot is cached.
        const items = (response.data ?? []).filter((item) => !removed.has(item.id))
        setState("items", key, items)
        console.debug(
          `[user-message-index] commit directory=${directory} sid=${sessionID} count=${items.length} removed=${removed.size}`,
        )
      })
      .catch((error) => {
        if (!current()) {
          console.debug(`[user-message-index] discard-error directory=${directory} sid=${sessionID}`)
          return
        }
        setState("failed", key, true)
        console.warn(
          `[user-message-index] load-error directory=${directory} sid=${sessionID} error=${error instanceof Error ? error.message : String(error)}`,
        )
        throw error
      })
      .finally(() => {
        if (requests.get(key)?.promise !== promise) return
        requests.delete(key)
        setState("loading", key, false)
      })
    requests.set(key, { promise, removed })
    return promise
  }

  return {
    ensure,
    get(directory: string, sessionID: string) {
      return state.items[deps.key(directory, sessionID)]
    },
    loading(directory: string, sessionID: string) {
      return state.loading[deps.key(directory, sessionID)] ?? false
    },
    failed(directory: string, sessionID: string) {
      return state.failed[deps.key(directory, sessionID)] ?? false
    },
    remove(directory: string, sessionID: string, messageID: string) {
      const key = deps.key(directory, sessionID)
      const request = requests.get(key)
      request?.removed.add(messageID)
      if (state.items[key] !== undefined) {
        setState("items", key, (items) => items?.filter((item) => item.id !== messageID))
      }
      console.debug(
        `[user-message-index] remove directory=${directory} sid=${sessionID} message=${messageID} pending=${!!request}`,
      )
    },
    clear(directory: string, sessionIDs: string[]) {
      for (const sessionID of sessionIDs) {
        const key = deps.key(directory, sessionID)
        console.debug(`[user-message-index] clear directory=${directory} sid=${sessionID} pending=${requests.has(key)}`)
        requests.delete(key)
        setState(
          produce((draft) => {
            delete draft.items[key]
            delete draft.loading[key]
            delete draft.failed[key]
          }),
        )
      }
    },
    clearAll(reason: string) {
      console.debug(`[user-message-index] clear-all reason=${reason} pending=${requests.size}`)
      requests.clear()
      setState({ items: {}, loading: {}, failed: {} })
    },
    inspect() {
      return { requests: requests.size, cached: Object.keys(state.items).length }
    },
  }
}
