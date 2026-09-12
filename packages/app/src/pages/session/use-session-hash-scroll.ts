import type { UserMessage } from "@opencode-ai/sdk/v2"
import { useLocation, useNavigate } from "@solidjs/router"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js"
import { messageIdFromHash } from "./message-id-from-hash"
import {
  createMessageNavigation,
  type MessageNavigationTarget,
  type MessageNavigationToken,
} from "./message-navigation"
import { collectSessionLayoutMetrics, logSessionLayout } from "./session-layout-debug"
import { reachableTargetTop } from "./use-session-scroll-utils"

export const useSessionHashScroll = (input: {
  sessionKey: () => string
  sessionID: () => string | undefined
  directory?: () => string
  messagesReady: () => boolean
  live: () => boolean
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyBusy: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  currentMessageId: () => string | undefined
  pendingMessage: () => string | undefined
  setPendingMessage: (value: string | undefined) => void
  setSeekingMessage: (value: string | undefined) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  enterLive: () => void
  enterAnchored: () => void
  autoScroll: { pause: () => void; forceScrollToBottom: () => void }
  prepareNavigation?: () => void
  scroller: () => HTMLDivElement | undefined
  anchor: (id: string) => string
  revealMessage?: (id: string, behavior?: ScrollBehavior) => void
  scheduleScrollState: (el: HTMLDivElement) => void
  consumePendingMessage: (key: string) => string | undefined
  onNavigationError?: (error: Error) => void
}) => {
  const location = useLocation()
  const navigate = useNavigate()
  const navigation = createMessageNavigation()
  const [navigationTargetId, setNavigationTargetId] = createSignal<string>()
  const messageById = createMemo(() => new Map(input.visibleUserMessages().map((message) => [message.id, message])))
  let frame: number | undefined

  const trace = (stage: string, id?: string, extra = "") => {
    const root = input.scroller()
    const state = navigation.state()
    console.debug(
      `[jump] stage=${stage} generation=${state.generation} phase=${state.phase} id=${id ?? "none"} current=${input.currentMessageId() ?? "none"} hash=${location.hash || "none"} pendingHash=${state.pendingHash ?? "none"} scrollTop=${Math.round(root?.scrollTop ?? 0)} scrollHeight=${Math.round(root?.scrollHeight ?? 0)} clientHeight=${Math.round(root?.clientHeight ?? 0)} visible=${input.visibleUserMessages().length}${extra ? ` ${extra}` : ""}`,
    )
  }
  const traceLayout = (id: string, success: boolean) => {
    logSessionLayout(
      "hash:seek-finish",
      collectSessionLayoutMetrics({
        root: input.scroller(),
        sessionId: input.sessionID(),
        directory: input.directory?.(),
        renderedCount: input.visibleUserMessages().length,
        visibleCount: input.visibleUserMessages().length,
        currentId: input.currentMessageId(),
        seekingId: id,
        live: input.live(),
      }),
      { id, success },
    )
  }
  const cancelFrame = () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }
  const queue = (token: MessageNavigationToken, callback: () => void) => {
    frame = requestAnimationFrame(() => {
      frame = undefined
      if (!navigation.current(token)) {
        trace("frame-superseded", undefined, `oldGeneration=${token.generation}`)
        return
      }
      callback()
    })
  }
  const clearPending = () => {
    batch(() => {
      input.setPendingMessage(undefined)
      input.setSeekingMessage(undefined)
    })
  }
  const fail = (token: MessageNavigationToken, id: string, reason: string) => {
    if (!navigation.current(token)) return
    setNavigationTargetId(undefined)
    clearPending()
    trace("unavailable", id, `reason=${reason}`)
    input.onNavigationError?.(new Error(`Cannot navigate to message ${id}: ${reason}`))
  }
  const position = (root: HTMLDivElement, element: HTMLElement) => {
    const item = element.getBoundingClientRect()
    const box = root.getBoundingClientRect()
    const inset = Number.parseFloat(getComputedStyle(root).getPropertyValue("--session-title-inset")) || 0
    return {
      top: reachableTargetTop({
        itemTop: item.top,
        rootTop: box.top,
        scrollTop: root.scrollTop,
        inset,
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
      }),
      height: item.height,
    }
  }
  const seek = (
    token: MessageNavigationToken,
    target: Extract<MessageNavigationTarget, { kind: "message" | "anchor" }>,
  ) => {
    let layoutStarted = performance.now()
    let stableSince: number | undefined
    let geometry = ""
    let first = true
    const step = () => {
      if (!navigation.current(token)) return
      const root = input.scroller()
      const element = document.getElementById(target.kind === "message" ? input.anchor(target.id) : target.id)
      let aligned = false
      if (root && element instanceof HTMLElement && root.contains(element)) {
        const goal = position(root, element)
        const delta = goal.top - root.scrollTop
        aligned = Math.abs(delta) <= 2
        const nextGeometry = `${Math.round(goal.top)}:${Math.round(goal.height)}:${root.clientHeight}`
        if (!aligned || nextGeometry !== geometry) stableSince = undefined
        geometry = nextGeometry
        if (!aligned) {
          trace("seek-scroll", target.id, `targetTop=${Math.round(goal.top)} delta=${Math.round(delta)}`)
          if (input.revealMessage) input.revealMessage(target.id, first ? target.behavior : "auto")
          else root.scrollTo({ top: goal.top, behavior: first ? target.behavior : "auto" })
        } else stableSince ??= performance.now()
        first = false
      } else {
        stableSince = undefined
        trace("seek-reveal", target.id, `root=${!!root} mounted=${!!element}`)
        input.revealMessage?.(target.id, first ? target.behavior : "auto")
      }
      const now = performance.now()
      // A loaded target can be positioned immediately during an older fetch,
      // but cannot settle until that history/layout transaction is committed.
      if (navigation.state().historyPending || input.historyBusy()) {
        stableSince = undefined
        layoutStarted = now
        queue(token, step)
        return
      }
      const stable = stableSince !== undefined && now - stableSince >= 150
      const expired = now - layoutStarted >= 2_000
      if (stable || expired) {
        const success = stable || aligned
        if (!navigation.finishSeek(token, success)) return
        input.setSeekingMessage(undefined)
        trace("seek-finish", target.id, `success=${success} reason=${stable ? "stable" : "deadline"}`)
        traceLayout(target.id, success)
        if (!success) fail(token, target.id, "target did not become reachable")
        if (root) input.scheduleScrollState(root)
        return
      }
      queue(token, step)
    }
    step()
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
      if (target.kind === "live") {
        batch(() => {
          input.setActiveMessage(undefined)
          clearPending()
          input.enterLive()
        })
        input.autoScroll.forceScrollToBottom()
        navigation.finishSeek(action.token, true)
        const root = input.scroller()
        if (root) input.scheduleScrollState(root)
        return
      }
      // Seeking takes viewport ownership after history has been captured/merged;
      // no prepend anchor from an earlier loading phase may restore the old view.
      input.prepareNavigation?.()
      batch(() => {
        input.setPendingMessage(undefined)
        input.setSeekingMessage(target.id)
        if (target.kind === "message") input.setActiveMessage(messageById().get(target.id))
      })
      seek(action.token, target)
    })

  const request = (target: MessageNavigationTarget, writeHash: boolean) =>
    untrack(() => {
      cancelFrame()
      const hash =
        target.kind === "message" ? `#${input.anchor(target.id)}` : target.kind === "anchor" ? `#${target.id}` : ""
      navigation.request(target, writeHash ? hash : undefined)
      trace("request", target.kind === "live" ? undefined : target.id, `source=${writeHash ? "explicit" : "route"}`)
      input.prepareNavigation?.()
      batch(() => {
        setNavigationTargetId(navigation.state().positionTarget)
        input.setPendingMessage(target.kind === "message" ? target.id : undefined)
        input.setSeekingMessage(target.kind === "live" ? undefined : target.id)
        if (target.kind !== "live") {
          input.enterAnchored()
          input.autoScroll.pause()
        }
      })
      if (writeHash && (location.hash !== hash || navigation.state().pendingHash !== undefined)) {
        navigate(location.pathname + location.search + hash, { replace: true })
      }
      drive()
    })
  const targetFromHash = (hash: string, behavior: ScrollBehavior): MessageNavigationTarget => {
    if (!hash) return { kind: "live" }
    const id = messageIdFromHash(hash)
    return id ? { kind: "message", id, behavior } : { kind: "anchor", id: hash.replace(/^#/, ""), behavior }
  }
  const clearMessageHash = () =>
    untrack(() => {
      cancelFrame()
      navigation.request(undefined, "")
      setNavigationTargetId(undefined)
      input.setActiveMessage(undefined)
      input.consumePendingMessage(input.sessionKey())
      clearPending()
      trace("clear")
      if (location.hash || navigation.state().pendingHash !== undefined) {
        navigate(location.pathname + location.search, { replace: true })
      }
    })

  createEffect(
    on(
      () => [input.sessionKey(), input.sessionID(), location.hash] as const,
      ([key, sessionID, hash]) => {
        if (key !== navigation.state().sessionKey) {
          cancelFrame()
          navigation.reset(key, hash)
          setNavigationTargetId(undefined)
          if (!sessionID) return
          const pending = input.consumePendingMessage(key) ?? input.pendingMessage()
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
          navigate(location.pathname + location.search + pendingHash, { replace: true })
        }
        if (event === "external" && sessionID) request(targetFromHash(hash, "auto"), false)
        else drive()
      },
    ),
  )
  createEffect(
    on(
      () =>
        [
          input.messagesReady(),
          input.visibleUserMessages(),
          input.historyMore(),
          input.historyBusy(),
          input.pendingMessage(),
        ] as const,
      ([, , , , pending]) => {
        const target = navigation.state().target
        if (pending && (target?.kind !== "message" || target.id !== pending)) {
          request({ kind: "message", id: pending, behavior: "auto" }, true)
          return
        }
        drive()
      },
    ),
  )
  createEffect(
    on(
      input.live,
      (live) => {
        if (live && navigationTargetId()) clearMessageHash()
      },
      { defer: true },
    ),
  )

  onMount(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual"
  })
  onCleanup(() => {
    navigation.reset("", "")
    setNavigationTargetId(undefined)
    cancelFrame()
  })

  return {
    navigationTargetId,
    clearMessageHash,
    scrollToMessageId: (id: string, behavior: ScrollBehavior = "auto") =>
      request({ kind: "message", id, behavior }, true),
    scrollToMessage: (message: UserMessage, behavior: ScrollBehavior = "smooth") =>
      request({ kind: "message", id: message.id, behavior }, true),
    applyHash: (behavior: ScrollBehavior) => request(targetFromHash(location.hash, behavior), false),
  }
}
