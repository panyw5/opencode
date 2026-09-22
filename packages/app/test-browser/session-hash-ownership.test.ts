import { expect, test } from "bun:test"
import { createComponent, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createBeforeLeave, createRouter, Route } from "@solidjs/router"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { useSessionHashScroll } from "../src/pages/session/use-session-hash-scroll"

type Controller = ReturnType<typeof useSessionHashScroll>

const userMessage = (id: string) => ({ id, role: "user", time: { created: 1 } }) as UserMessage

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function createStatefulHistory(beforeLeave: ReturnType<typeof createBeforeLeave>) {
  let index = 0
  const entries = [{ value: "/", state: undefined as unknown }]
  const listeners = new Set<(value: { value: string; state?: unknown }) => void>()
  const calls: Array<{ value: string; replace?: boolean; scroll?: boolean; state?: unknown }> = []
  const traversalDeltas: number[] = []
  const notify = () => {
    const entry = entries[index]
    for (const listener of listeners) listener(entry)
  }
  const history = {
    get: () => entries[index],
    set: (change: { value: string; replace?: boolean; scroll?: boolean; state?: unknown }) => {
      calls.push({ ...change })
      const entry = { value: change.value, state: change.state }
      if (change.replace) entries[index] = entry
      else {
        entries.splice(index + 1)
        entries.push(entry)
        index += 1
      }
      notify()
    },
    go: (delta: number) => {
      traversalDeltas.push(delta)
      if (!beforeLeave.confirm(delta)) return
      index = Math.max(0, Math.min(entries.length - 1, index + delta))
      notify()
    },
    listen: (listener: (value: { value: string; state?: unknown }) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    history: history as any,
    calls,
    current: () => entries[index],
    go: history.go,
    traversalDeltas,
    external(value: string, state?: unknown, replace = false) {
      history.set({ value, state, replace, scroll: false })
    },
  }
}

function setup(options: { keepViewOnMount?: boolean } = {}) {
  const root = document.createElement("div")
  document.body.append(root)
  const beforeLeave = createBeforeLeave()
  const historyFixture = createStatefulHistory(beforeLeave)
  const history = historyFixture.history
  const RouterComponent = createRouter({
    get: () => historyFixture.current(),
    set: (change) => history.set(change),
    init: (notify) => history.listen(notify),
    utils: { go: history.go, beforeLeave },
  })
  const [store, setStore] = createStore({
    ready: true,
    visible: [] as UserMessage[],
    activeID: undefined as string | undefined,
  })
  const loadCalls: string[] = []
  const loadResolvers: Array<() => void> = []
  let controller!: Controller
  const sessionKey = () => (historyFixture.current().value === "/session-b" ? "session-b" : "session-a")

  const loadMore = (sessionID: string) => {
    loadCalls.push(sessionID)
    return new Promise<void>((resolve) => loadResolvers.push(resolve))
  }

  const Harness = () => {
    controller = useSessionHashScroll({
      sessionKey,
      sessionID: sessionKey,
      messagesReady: () => store.ready,
      visibleUserMessages: () => store.visible,
      historyMore: () => true,
      historyBusy: () => false,
      loadMore,
      currentMessageId: () => undefined,
      setActiveMessage: (value) => setStore("activeID", value?.id),
      scroller: () => root,
      anchor: (id) => `message-${id}`,
      consumePendingMessage: () => undefined,
    })
    onMount(() => options.keepViewOnMount && controller.keepView())
    return null
  }

  const dispose = render(
    () =>
      createComponent(RouterComponent, {
        children: createComponent(Route, { path: "*", component: Harness }),
      }),
    root,
  )

  return {
    controller: () => controller,
    dispose,
    history: historyFixture,
    loadCalls,
    loadResolvers,
    setStore,
    store,
  }
}

test("user takeover clears a pending message/hash and stale history completion cannot revive it", async () => {
  const fixture = setup()
  await tick()
  fixture.controller().scrollToMessageId("old", "auto")
  await tick()

  expect(fixture.loadCalls).toEqual(["session-a"])
  expect(fixture.history.current().value).toContain("message-old")

  fixture.controller().userInput({ direction: "up", atBottom: false })
  await tick()
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "reading" })
  expect(fixture.history.current().value).toBe("/")

  fixture.loadResolvers.shift()?.()
  await tick()
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "reading" })
  expect(fixture.controller().navigationTargetId()).toBeUndefined()
  fixture.dispose()
})

test("new keep-view intent wins over deferred session bootstrap", async () => {
  const fixture = setup({ keepViewOnMount: true })
  await tick()
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "reading" })
  expect(fixture.loadCalls).toEqual([])
  fixture.dispose()
})

test("following and reading snapshots do not mutate previously captured targets", async () => {
  const fixture = setup()
  await tick()
  fixture.controller().resumeLive()
  await tick()
  const following = fixture.controller().navigationState.target
  expect(following).toEqual({ kind: "live" })

  fixture.controller().takeoverReading()
  await tick()
  expect(following).toEqual({ kind: "live" })
  expect(fixture.controller().navigationState.target).toEqual({ kind: "reading" })
  fixture.dispose()
})

test("a new request intentionally navigates to a hash that was previously cleared", async () => {
  const fixture = setup()
  fixture.setStore("visible", [userMessage("first")])
  await tick()

  fixture.controller().scrollToMessageId("first", "auto")
  await tick()
  const firstGeneration = fixture.controller().navigationState.generation
  expect(fixture.history.current().value).toContain("message-first")

  fixture.controller().userInput({ direction: "up", atBottom: false })
  await tick()
  expect(fixture.history.current().value).toBe("/")

  fixture.controller().scrollToMessageId("first", "auto")
  await tick()
  expect(fixture.controller().navigationState.generation).toBeGreaterThan(firstGeneration)
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "message", id: "first", behavior: "auto" })
  expect(fixture.history.current().value).toContain("message-first")
  fixture.dispose()
})

test("an external router navigation to the prior hash is honored after takeover", async () => {
  const fixture = setup()
  fixture.setStore("visible", [userMessage("first")])
  await tick()

  fixture.controller().scrollToMessageId("first", "auto")
  await tick()
  fixture.controller().userInput({ direction: "up", atBottom: false })
  await tick()
  expect(fixture.history.current().value).toBe("/")

  // This bypasses the hook request API and represents a fresh route change.
  fixture.history.external("/#message-first")
  await tick()
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "message", id: "first", behavior: "auto" })
  fixture.dispose()
})

test("overlapping own hash writes keep the latest intent", async () => {
  const fixture = setup()
  fixture.setStore("visible", [userMessage("first")])
  await tick()

  fixture.controller().scrollToMessageId("first", "auto")
  fixture.controller().userInput({ direction: "up", atBottom: false })
  await tick()
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "reading" })
  expect(fixture.history.current().value).toBe("/")
  expect(fixture.history.calls.at(-1)?.scroll).toBe(false)
  fixture.dispose()
})

test("message and find target snapshots remain immutable across target replacement", async () => {
  const fixture = setup()
  fixture.setStore("visible", [userMessage("first")])
  await tick()

  fixture.controller().scrollToMessageId("first", "auto")
  await tick()
  const messageTarget = fixture.controller().navigationState.target
  expect(messageTarget).toEqual({ kind: "message", id: "first", behavior: "auto" })

  const findTarget = {
    kind: "find" as const,
    rowKey: "user-message:first",
    messageID: "first",
    partID: "part-1",
    occurrence: 0,
    query: "needle",
    queryVersion: 1,
  }
  fixture.controller().scrollToFind(findTarget)
  await tick()
  const capturedFindTarget = fixture.controller().navigationState.target
  expect(messageTarget).toEqual({ kind: "message", id: "first", behavior: "auto" })
  expect(capturedFindTarget).toEqual(findTarget)

  fixture.controller().takeoverReading()
  await tick()
  expect(capturedFindTarget).toEqual(findTarget)
  fixture.dispose()
})

test("a settled user back navigation to an earlier route entry is honored", async () => {
  const fixture = setup()
  fixture.setStore("visible", [userMessage("first"), userMessage("second")])
  await tick()

  fixture.history.external("/#message-first")
  await tick()
  fixture.history.external("/#message-second")
  await tick()
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "message", id: "second", behavior: "auto" })

  // Router.js confirms traversal before notifying the source; this is a real
  // back operation, not a replay of an older internal set() callback.
  fixture.history.go(-1)
  await tick()
  expect(fixture.history.traversalDeltas).toEqual([-1])
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "message", id: "first", behavior: "auto" })
  expect(fixture.loadCalls).toEqual([])
  fixture.dispose()
})

test("switching session scope invalidates an old history completion", async () => {
  const fixture = setup()
  await tick()
  fixture.controller().scrollToMessageId("old", "auto")
  await tick()
  expect(fixture.loadCalls).toEqual(["session-a"])

  fixture.history.external("/session-b", undefined, true)
  await tick()
  expect(fixture.loadCalls).toEqual(["session-a"])
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "live" })
  fixture.loadResolvers.shift()?.()
  await tick()

  expect(fixture.controller().navigationState.sessionKey).toBe("session-b")
  expect(fixture.loadCalls).toEqual(["session-a"])
  expect(fixture.controller().viewportIntent()).toEqual({ kind: "live" })
  expect(fixture.controller().viewportIntent()).not.toEqual({ kind: "message", id: "old", behavior: "auto" })
  fixture.dispose()
})
