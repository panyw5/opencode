export type MessageNavigationTarget =
  | { kind: "message"; id: string; behavior: ScrollBehavior }
  | { kind: "anchor"; id: string; behavior: ScrollBehavior }
  | { kind: "live" }

export type MessageNavigationToken = { sessionKey: string; generation: number }
export type MessageNavigationPhase = "idle" | "waiting" | "loading" | "seeking" | "settled" | "unavailable" | "failed"
export type MessageNavigationAction =
  | { kind: "load"; token: MessageNavigationToken }
  | { kind: "seek"; token: MessageNavigationToken; target: MessageNavigationTarget }
  | { kind: "unavailable"; token: MessageNavigationToken; id: string }

/** One intent owns both paginated history loading and virtual DOM positioning. */
export function createMessageNavigation() {
  let sessionKey = ""
  let generation = 0
  let target: MessageNavigationTarget | undefined
  let phase: MessageNavigationPhase = "idle"
  let observedHash = ""
  let pendingHash: string | undefined
  let ownedHash: string | undefined
  const supersededHashes = new Set<string>()
  let loadToken: MessageNavigationToken | undefined
  const token = (): MessageNavigationToken => ({ sessionKey, generation })
  const current = (value: MessageNavigationToken) => value.sessionKey === sessionKey && value.generation === generation

  return {
    state: () => ({
      sessionKey,
      generation,
      target,
      phase,
      pendingHash,
      historyPending: !!loadToken,
      positionTarget:
        target && target.kind !== "live" && !["idle", "unavailable", "failed"].includes(phase) ? target.id : undefined,
    }),
    current,
    reset(key: string, hash: string) {
      sessionKey = key
      generation += 1
      target = undefined
      phase = "idle"
      observedHash = hash
      pendingHash = undefined
      ownedHash = undefined
      supersededHashes.clear()
      loadToken = undefined
    },
    request(next: MessageNavigationTarget | undefined, hash?: string) {
      generation += 1
      target = next
      phase = next ? "waiting" : "idle"
      if (hash !== undefined) {
        supersededHashes.add(observedHash)
        if (ownedHash !== undefined) supersededHashes.add(ownedHash)
        supersededHashes.delete(hash)
      } else supersededHashes.clear()
      ownedHash = hash
      // Router writes are asynchronous. Intermediate/old hashes are not new
      // requests until the router acknowledges this intent's desired hash.
      pendingHash = hash !== undefined && (hash !== observedHash || pendingHash !== undefined) ? hash : undefined
      return token()
    },
    observeHash(hash: string): "unchanged" | "acknowledged" | "superseded" | "external" {
      const changed = hash !== observedHash
      observedHash = hash
      if (pendingHash !== undefined) {
        if (hash !== pendingHash) {
          if (supersededHashes.has(hash)) return "superseded"
          pendingHash = undefined
          ownedHash = undefined
          return "external"
        }
        pendingHash = undefined
        return "acknowledged"
      }
      if (
        ownedHash !== undefined &&
        ["waiting", "loading", "seeking"].includes(phase) &&
        hash !== ownedHash &&
        supersededHashes.has(hash)
      ) {
        pendingHash = ownedHash
        return "superseded"
      }
      return changed ? "external" : "unchanged"
    },
    reconcile(input: {
      ready: boolean
      loaded: boolean
      more: boolean
      busy: boolean
    }): MessageNavigationAction | undefined {
      if (!target || ["seeking", "settled", "unavailable", "failed"].includes(phase)) return
      if (!input.ready) {
        phase = "waiting"
        return
      }
      if (target.kind !== "message" || input.loaded) {
        phase = "seeking"
        return { kind: "seek", token: token(), target }
      }
      if (loadToken || input.busy) {
        phase = "waiting"
        return
      }
      if (!input.more) {
        phase = "unavailable"
        return { kind: "unavailable", token: token(), id: target.id }
      }
      phase = "loading"
      loadToken = token()
      return { kind: "load", token: loadToken }
    },
    finishLoad(value: MessageNavigationToken, failed = false) {
      if (!loadToken || loadToken.sessionKey !== value.sessionKey || loadToken.generation !== value.generation)
        return false
      loadToken = undefined
      if (failed && current(value)) phase = "failed"
      return true
    },
    finishSeek(value: MessageNavigationToken, success: boolean) {
      if (!current(value)) return false
      if (success && loadToken) return false
      phase = success ? "settled" : "unavailable"
      return true
    },
  }
}
