import type { UserMessage } from "@opencode-ai/sdk/v2"
import { useLocation, useNavigate } from "@solidjs/router"
import { batch, createEffect, createMemo, on, onCleanup, onMount, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { messageIdFromHash } from "./message-id-from-hash"
import {
  createMessageNavigation,
  type MessageNavigationSnapshot,
  type MessageNavigationSource,
  type MessageNavigationTarget,
  type MessageNavigationToken,
  type FindNavigationTarget,
} from "./message-navigation"

export const useSessionHashScroll = (input: {
  sessionKey: () => string
  sessionID: () => string | undefined
  directory?: () => string
  messagesReady: () => boolean
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyBusy: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  currentMessageId: () => string | undefined
  setActiveMessage: (message: UserMessage | undefined) => void
  prepareNavigation?: (target: MessageNavigationTarget) => void
  scroller: () => HTMLDivElement | undefined
  anchor: (id: string) => string
  consumePendingMessage: (key: string) => string | undefined
  onNavigationError?: (error: Error) => void
}) => {
  const location = useLocation()
  const navigate = useNavigate()
  let publishNavigationState: (value: MessageNavigationSnapshot) => void = () => {}
  const navigation = createMessageNavigation({
    onChange: (next) => publishNavigationState(next),
  })
  const [navigationState, updateNavigationState] = createStore<MessageNavigationSnapshot>(navigation.snapshot())
  publishNavigationState = (value) => updateNavigationState(value)
  const navigationTargetId = () => navigationState.positionTarget
  const viewportTarget = () => navigationState.viewportTarget
  const viewportIntent = () => navigationState.target
  const messageById = createMemo(() => new Map(input.visibleUserMessages().map((message) => [message.id, message])))

  const trace = (stage: string, id?: string, extra = "") => {
    const root = input.scroller()
    const state = navigation.state()
    console.debug(
      `[jump] stage=${stage} generation=${state.generation} phase=${state.phase} id=${id ?? "none"} current=${input.currentMessageId() ?? "none"} hash=${location.hash || "none"} pendingHash=${state.pendingHash ?? "none"} scrollTop=${Math.round(root?.scrollTop ?? 0)} scrollHeight=${Math.round(root?.scrollHeight ?? 0)} clientHeight=${Math.round(root?.clientHeight ?? 0)} visible=${input.visibleUserMessages().length}${extra ? ` ${extra}` : ""}`,
    )
  }
  const fail = (token: MessageNavigationToken, id: string, reason: string) => {
    if (!navigation.current(token)) return
    request({ kind: "reading" }, true, "user-scroll")
    trace("unavailable", id, `reason=${reason}`)
    input.onNavigationError?.(new Error(`Cannot navigate to message ${id}: ${reason}`))
  }
  // Effects supply snapshots, never requests inferred from current-message updates.
  // The controller alone decides whether an intent needs loading or DOM positioning.
  const drive: () => void = () =>
    untrack(() => {
      const state = navigation.state()
      if (state.sessionKey !== input.sessionKey()) return
      const id = state.target?.kind === "message" ? state.target.id : undefined
      const action = navigation.reconcile({
        ready: input.messagesReady(),
        loaded: !!id && messageById().has(id),
        more: input.historyMore(),
        busy: input.historyBusy(),
      })
      if (!action) return
      trace(`action-${action.kind}`, id)
      if (action.kind === "unavailable") {
        fail(action.token, action.id, "history exhausted or message hidden")
        return
      }
      if (action.kind === "load") {
        const sessionID = input.sessionID()
        if (!sessionID) return
        trace("load-start", id)
        void input.loadMore(sessionID).then(
          () => {
            if (!navigation.finishLoad(action.token)) return
            trace("load-finish", id, `oldGeneration=${action.token.generation}`)
            drive()
          },
          (error: unknown) => {
            if (!navigation.finishLoad(action.token, true)) return
            console.error(`[jump] load-error sid=${sessionID} generation=${action.token.generation}`, error)
            if (navigation.current(action.token)) fail(action.token, id ?? "none", "history load failed")
            else drive()
          },
        )
        return
      }
      const target = action.target
      if (target.kind === "reading") {
        navigation.finishSeek(action.token, true)
        return
      }
      if (target.kind === "live") {
        input.setActiveMessage(undefined)
        navigation.finishSeek(action.token, true)
        return
      }
      // Seeking takes viewport ownership after history has been captured/merged;
      // no prepend anchor from an earlier loading phase may restore the old view.
      input.prepareNavigation?.(target)
      if (target.kind === "message") input.setActiveMessage(messageById().get(target.id))
    })

  const applyIntent = (target: MessageNavigationTarget, hash?: string) => {
    batch(() => {
      if (target.kind !== "message") input.setActiveMessage(undefined)
    })
    input.prepareNavigation?.(target)
    if (hash !== undefined && (location.hash !== hash || navigation.state().pendingHash !== undefined)) {
      navigateHash(hash)
    }
  }
  const navigateHash = (hash: string) => {
    navigate(location.pathname + location.search + hash, {
      replace: true,
      scroll: false,
    })
  }
  const request = (target: MessageNavigationTarget, writeHash: boolean, source: MessageNavigationSource = "route") =>
    untrack(() => {
      const hash =
        target.kind === "message" ? `#${input.anchor(target.id)}` : target.kind === "anchor" ? `#${target.id}` : ""
      navigation.request(target, writeHash ? hash : undefined, source)
      trace(
        "request",
        target.kind === "live"
          ? undefined
          : target.kind === "message" || target.kind === "anchor"
            ? target.id
            : undefined,
        `source=${writeHash ? "explicit" : "route"}`,
      )
      applyIntent(target, writeHash ? hash : undefined)
      drive()
    })
  const userInput = (value: { direction: "up" | "down" | "other"; atBottom: boolean }) =>
    untrack(() => {
      const before = navigation.state()
      const token = navigation.userInput(value)
      const after = navigation.state()
      if (after.generation !== before.generation || after.target !== before.target) {
        const hash =
          after.pendingHash ?? (after.target?.kind === "live" || after.target?.kind === "reading" ? "" : undefined)
        if (after.target) applyIntent(after.target, hash)
        trace("user-input", undefined, `direction=${value.direction} atBottom=${String(value.atBottom)}`)
        drive()
      }
      return token
    })
  const observeUserMotion = (value: { direction: "up" | "down" | "other"; atBottom: boolean }) =>
    untrack(() => {
      const before = navigation.state()
      const token = navigation.observeUserMotion(value)
      const after = navigation.state()
      if (after.generation !== before.generation || after.target !== before.target) {
        const hash = after.pendingHash ?? ""
        if (after.target) applyIntent(after.target, hash)
        trace("user-motion-observed", undefined, `direction=${value.direction} atBottom=${String(value.atBottom)}`)
        drive()
      }
      return token
    })
  const targetFromHash = (hash: string, behavior: ScrollBehavior): MessageNavigationTarget => {
    if (!hash) return { kind: "live" }
    const id = messageIdFromHash(hash)
    return id ? { kind: "message", id, behavior } : { kind: "anchor", id: hash.replace(/^#/, ""), behavior }
  }
  createEffect(
    on(
      () => [input.sessionKey(), input.sessionID(), location.hash] as const,
      ([key, sessionID, hash]) => {
        if (key !== navigation.state().sessionKey) {
          navigation.reset(key, hash, "session")
          if (!sessionID) return
          const pending = input.consumePendingMessage(key)
          request(
            pending ? { kind: "message", id: pending, behavior: "auto" } : targetFromHash(hash, "auto"),
            !!pending,
          )
          return
        }
        const event = navigation.observeHash(hash)
        trace(`route-${event}`)
        const pendingHash = navigation.state().pendingHash
        if (event === "superseded" && pendingHash !== undefined && hash !== pendingHash) {
          navigateHash(pendingHash)
        }
        if (event === "external" && sessionID) request(targetFromHash(hash, "auto"), false)
        else drive()
      },
    ),
  )
  createEffect(
    on(
      () => [input.messagesReady(), input.visibleUserMessages(), input.historyMore(), input.historyBusy()] as const,
      () => {
        drive()
      },
    ),
  )
  onMount(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual"
  })
  onCleanup(() => {
    navigation.reset("", "")
  })

  return {
    navigationTargetId,
    viewportTarget,
    viewportIntent,
    navigationState,
    finishNavigation: (token: MessageNavigationToken, success: boolean) => {
      const finished = navigation.finishSeek(token, success)
      return finished
    },
    failNavigation: (token: MessageNavigationToken) => {
      const target = navigation.state().target
      const id = target?.kind === "message" ? target.id : "target"
      if (navigation.current(token)) fail(token, id, "target did not become reachable")
    },
    userInput,
    observeUserMotion,
    takeoverReading: () => request({ kind: "reading" }, true, "user-scroll"),
    keepView: () => request({ kind: "reading" }, true, "keep-view"),
    scrollToFind: (target: FindNavigationTarget) => request(target, true, "find"),
    resumeLive: () => request({ kind: "live" }, true, "following"),
    scrollToMessageId: (id: string, behavior: ScrollBehavior = "auto") =>
      request({ kind: "message", id, behavior }, true, "message"),
    scrollToMessage: (message: UserMessage, behavior: ScrollBehavior = "smooth") =>
      request({ kind: "message", id: message.id, behavior }, true, "message"),
    applyHash: (behavior: ScrollBehavior) => request(targetFromHash(location.hash, behavior), false),
  }
}
