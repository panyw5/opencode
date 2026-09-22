export type MessageNavigationTarget =
  | { kind: "message"; id: string; behavior: ScrollBehavior }
  | { kind: "anchor"; id: string; behavior: ScrollBehavior }
  | { kind: "reading" }
  | FindNavigationTarget
  | { kind: "live" }

export type FindNavigationTarget = {
  kind: "find"
  rowKey: string
  messageID: string
  partID: string
  occurrence: number
  query: string
  queryVersion: number
}

export type FindPositionResult = {
  available: boolean
  aligned: boolean
  geometry: string
  top?: number
}

export type MessageNavigationToken = { sessionKey: string; generation: number }
export type MessageNavigationPhase = "idle" | "waiting" | "loading" | "seeking" | "settled" | "unavailable" | "failed"
export type MessageNavigationSource =
  | "route"
  | "message"
  | "anchor"
  | "find"
  | "reading"
  | "following"
  | "user-scroll"
  | "send"
  | "keep-view"
  | "initial"
  | "clear"
  | "session"
  | "hash"
  | "reconcile"
  | "load"
  | "seek"

export type MessageNavigationSnapshot = {
  sessionKey: string
  generation: number
  target: MessageNavigationTarget | undefined
  phase: MessageNavigationPhase
  pendingHash: string | undefined
  historyPending: boolean
  source: MessageNavigationSource
  following: boolean
  reading: boolean
  positionTarget: string | undefined
  viewportTarget: Exclude<MessageNavigationTarget, { kind: "reading" | "live" }> | undefined
}

export type MessageNavigationUserInput = {
  direction: "up" | "down" | "other"
  atBottom: boolean
}

export type MessageNavigationAction =
  | { kind: "load"; token: MessageNavigationToken }
  | { kind: "seek"; token: MessageNavigationToken; target: MessageNavigationTarget }
  | { kind: "unavailable"; token: MessageNavigationToken; id: string }

/** One intent owns both paginated history loading and virtual DOM positioning. */
export function createMessageNavigation(
  options: {
    onChange?: (
      snapshot: MessageNavigationSnapshot,
      previous: MessageNavigationSnapshot,
      source: MessageNavigationSource,
    ) => void
  } = {},
) {
  let sessionKey = ""
  let generation = 0
  let target: MessageNavigationTarget | undefined
  let phase: MessageNavigationPhase = "idle"
  let requestSource: MessageNavigationSource = "session"
  let observedHash = ""
  let pendingHash: string | undefined
  let ownedHash: string | undefined
  const supersededHashes = new Set<string>()
  let loadToken: MessageNavigationToken | undefined
  const token = (): MessageNavigationToken => ({ sessionKey, generation })
  const current = (value: MessageNavigationToken) => value.sessionKey === sessionKey && value.generation === generation
  const sameTarget = (left: MessageNavigationTarget | undefined, right: MessageNavigationTarget | undefined) => {
    if (left === right) return true
    if (!left || !right || left.kind !== right.kind) return false
    if ((left.kind === "message" || left.kind === "anchor") && (right.kind === "message" || right.kind === "anchor")) {
      return left.id === right.id && left.behavior === right.behavior
    }
    if (left.kind === "find" && right.kind === "find") {
      return (
        left.rowKey === right.rowKey &&
        left.messageID === right.messageID &&
        left.partID === right.partID &&
        left.occurrence === right.occurrence &&
        left.query === right.query &&
        left.queryVersion === right.queryVersion
      )
    }
    return true
  }
  const snapshot = (): MessageNavigationSnapshot => {
    const terminal = ["idle", "unavailable", "failed"].includes(phase)
    return {
      sessionKey,
      generation,
      target,
      phase,
      pendingHash,
      historyPending: !!loadToken,
      source: requestSource,
      following: target?.kind === "live",
      reading: target?.kind === "reading",
      positionTarget:
        target && (target.kind === "message" || target.kind === "anchor") && !terminal ? target.id : undefined,
      viewportTarget: target && target.kind !== "live" && target.kind !== "reading" && !terminal ? target : undefined,
    }
  }
  let previous = snapshot()
  const publish = (nextSource: MessageNavigationSource, updateRequestSource = false) => {
    if (updateRequestSource) requestSource = nextSource
    const next = snapshot()
    const prior = previous
    previous = next
    options.onChange?.(next, prior, nextSource)
  }
  const request = (
    next: MessageNavigationTarget | undefined,
    hash?: string,
    nextSource: MessageNavigationSource = "route",
  ) => {
    const retryTerminal = sameTarget(target, next) && ["unavailable", "failed"].includes(phase)
    const changedIntent = !sameTarget(target, next) || retryTerminal
    if (changedIntent) {
      generation += 1
      target = next
      phase = next ? "waiting" : "idle"
    }
    if (hash !== undefined) {
      supersededHashes.add(observedHash)
      if (ownedHash !== undefined) supersededHashes.add(ownedHash)
      supersededHashes.delete(hash)
    } else supersededHashes.clear()
    ownedHash = hash
    // Router writes are asynchronous. Intermediate/old hashes are not new
    // requests until the router acknowledges this intent's desired hash.
    pendingHash = hash !== undefined && (hash !== observedHash || pendingHash !== undefined) ? hash : undefined
    const requestedToken = token()
    if (changedIntent || requestSource !== nextSource || pendingHash !== previous.pendingHash) publish(nextSource, true)
    return requestedToken
  }

  return {
    state: snapshot,
    snapshot,
    current,
    reset(key: string, hash: string, resetSource: MessageNavigationSource = "session") {
      sessionKey = key
      generation += 1
      target = undefined
      phase = "idle"
      observedHash = hash
      pendingHash = undefined
      ownedHash = undefined
      supersededHashes.clear()
      loadToken = undefined
      publish(resetSource, true)
    },
    request,
    requestReading(
      next: Extract<MessageNavigationTarget, { kind: "reading" }> = { kind: "reading" },
      hash?: string,
      requestSource: MessageNavigationSource = "reading",
    ) {
      return request(next, hash, requestSource)
    },
    requestFollowing(hash?: string, requestSource: MessageNavigationSource = "following") {
      return request({ kind: "live" }, hash, requestSource)
    },
    requestFind(
      next: Extract<MessageNavigationTarget, { kind: "find" }>,
      hash?: string,
      requestSource: MessageNavigationSource = "find",
    ) {
      return request(next, hash, requestSource)
    },
    cancel(hash = "", requestSource: MessageNavigationSource = "clear") {
      return request(undefined, hash, requestSource)
    },
    userInput(input: MessageNavigationUserInput) {
      if (target?.kind === "live") {
        if (input.direction === "up") return request({ kind: "reading" }, "", "user-scroll")
        return token()
      }
      if (target?.kind === "reading") {
        if (input.direction === "down" && input.atBottom) return request({ kind: "live" }, "", "user-scroll")
        return token()
      }
      if (target) {
        return request({ kind: "reading" }, "", "user-scroll")
      }
      return token()
    },
    observeUserMotion(input: MessageNavigationUserInput) {
      if (target?.kind === "reading" && input.direction === "down" && input.atBottom)
        return request({ kind: "live" }, "", "user-scroll")
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
          publish("hash")
          return "external"
        }
        pendingHash = undefined
        publish("hash")
        return "acknowledged"
      }
      if (
        ownedHash !== undefined &&
        ["waiting", "loading", "seeking"].includes(phase) &&
        hash !== ownedHash &&
        supersededHashes.has(hash)
      ) {
        pendingHash = ownedHash
        publish("hash")
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
        if (phase !== "waiting") {
          phase = "waiting"
          publish("reconcile")
        }
        return
      }
      // Reading mode takes over the viewport without asking history to load or
      // issuing a DOM seek. Any fetch owned by the prior intent remains releasable.
      if (target.kind === "reading") {
        if (phase !== "settled") {
          phase = "settled"
          publish("reconcile")
        }
        return
      }
      if (target.kind !== "message" || input.loaded) {
        const actionToken = token()
        const actionTarget = target
        phase = "seeking"
        publish("reconcile")
        return { kind: "seek", token: actionToken, target: actionTarget }
      }
      if (loadToken || input.busy) {
        if (phase !== "waiting") {
          phase = "waiting"
          publish("reconcile")
        }
        return
      }
      if (!input.more) {
        const actionToken = token()
        const id = target.id
        phase = "unavailable"
        publish("reconcile")
        return { kind: "unavailable", token: actionToken, id }
      }
      const actionToken = token()
      phase = "loading"
      loadToken = actionToken
      const actionLoadToken = loadToken
      publish("reconcile")
      return { kind: "load", token: actionLoadToken }
    },
    finishLoad(value: MessageNavigationToken, failed = false) {
      if (!loadToken || loadToken.sessionKey !== value.sessionKey || loadToken.generation !== value.generation)
        return false
      loadToken = undefined
      if (failed && current(value)) phase = "failed"
      publish("load")
      return true
    },
    finishSeek(value: MessageNavigationToken, success: boolean) {
      if (!current(value)) return false
      if (success && loadToken) return false
      phase = success ? "settled" : "unavailable"
      publish("seek")
      return true
    },
  }
}
