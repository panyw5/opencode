import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { Bus } from "../../src/bus"
import { BrowserBridge } from "../../src/browser/bridge"
import { Updated as BrowserUpdated, GptProNotificationReceived } from "../../src/browser/events"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef } from "@/effect/instance-ref"
import { testEffect } from "../lib/effect"

const it = testEffect(BrowserBridge.layer)

type FakeAdapter = {
  adapter: BrowserBridge.Adapter
  sent: string[]
  closed: boolean
}

function fakeAdapter(): FakeAdapter {
  const sent: string[] = []
  const fake: FakeAdapter = {
    sent,
    closed: false,
    adapter: {
      send: (data) => {
        sent.push(data)
      },
      close: () => {
        fake.closed = true
      },
    },
  }
  return fake
}

const viewState = {
  partition: "persist:browse",
  url: "https://example.com/",
  title: "Example Domain",
  loading: false,
  shared: false,
}

const failureOf = (exit: Exit.Exit<unknown, BrowserBridge.CommandError>) =>
  Exit.isFailure(exit)
    ? (exit.cause as unknown as { reasons?: Array<{ error?: unknown }> }).reasons?.[0]?.error
    : undefined

/** Send a resp frame for the single in-flight command (or the given id). */
const respond = (bridge: BrowserBridge.Interface, fake: FakeAdapter, ok: boolean, result: unknown) => {
  const frame = JSON.parse(fake.sent[0])
  expect(frame.type).toBe("cmd")
  return bridge.handleFrame(JSON.stringify({ type: "resp", id: frame.id, ok, result }))
}

/** Fake InstanceContext for Bus tests: module-level Bus.subscribe resolves
 * InstanceState from the InstanceRef attached to the calling fiber. */
const busTestInstance = {
  directory: "/tmp/opencode-bridge-bus-test",
  directoryKey: "/tmp/opencode-bridge-bus-test",
  nativeDirectory: "/tmp/opencode-bridge-bus-test",
  worktree: "/tmp/opencode-bridge-bus-test",
  project: { id: "proj_browser_test" },
  location: { id: "loc_browser_test" },
} as unknown as InstanceContext

describe("BrowserBridge service", () => {
  it.live("round-trips a command response", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      const fiber = yield* bridge.command<string>("navigate", { url: "https://example.com/" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* respond(bridge, fake, true, { url: "https://example.com/", title: "Example Domain" })

      expect(yield* Fiber.join(fiber)).toEqual({ url: "https://example.com/", title: "Example Domain" })
    }),
  )

  it.live("fails a command when the client reports an error", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      const fiber = yield* bridge.command("snapshot").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* respond(bridge, fake, false, undefined)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = failureOf(exit)
      expect(failure).toBeInstanceOf(BrowserBridge.CommandFailedError)
    }),
  )

  it.live("times out a command without a response", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      const exit = yield* Effect.exit(
        bridge.command("navigate", { url: "https://example.com/" }, { timeout: "20 millis" }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = failureOf(exit)
      expect(failure).toBeInstanceOf(BrowserBridge.TimeoutError)
    }),
  )

  it.live("rejects commands while no client is connected", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service

      const exit = yield* Effect.exit(bridge.command("navigate", { url: "https://example.com/" }))
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = failureOf(exit)
      expect(failure).toBeInstanceOf(BrowserBridge.AbsentError)
    }),
  )

  it.live("fails pending commands when the client disconnects", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      const fiber = yield* bridge.command("navigate", { url: "https://example.com/" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* bridge.disconnect()

      const exit = yield* Fiber.await(fiber)
      const failure = failureOf(exit)
      expect(failure).toBeInstanceOf(BrowserBridge.AbsentError)
      expect(fake.sent[0]).toBeDefined()
    }),
  )

  it.live("isolates concurrent commands by id", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      const first = yield* bridge.command<string>("navigate", { url: "https://a.com/" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const second = yield* bridge.command<string>("navigate", { url: "https://b.com/" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(fake.sent).toHaveLength(2)
      const idA = JSON.parse(fake.sent[0]).id
      const idB = JSON.parse(fake.sent[1]).id
      expect(idA).not.toBe(idB)

      // Reply out of order: B first, then A.
      yield* bridge.handleFrame(JSON.stringify({ type: "resp", id: idB, ok: true, result: "b" }))
      yield* bridge.handleFrame(JSON.stringify({ type: "resp", id: idA, ok: true, result: "a" }))

      expect(yield* Fiber.join(first)).toBe("a")
      expect(yield* Fiber.join(second)).toBe("b")
    }),
  )

  it.live("replaces a previous connection and fails its pending commands", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const first = fakeAdapter()
      yield* bridge.connect({ adapter: first.adapter })

      const fiber = yield* bridge.command("navigate", { url: "https://example.com/" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow

      const second = fakeAdapter()
      yield* bridge.connect({ adapter: second.adapter })

      expect(first.closed).toBe(true)
      const exit = yield* Fiber.await(fiber)
      const failure = failureOf(exit)
      expect(failure).toBeInstanceOf(BrowserBridge.AbsentError)

      // The replacement connection is fully usable.
      const fiber2 = yield* bridge.command<string>("state").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const frame = JSON.parse(second.sent[0])
      yield* bridge.handleFrame(JSON.stringify({ type: "resp", id: frame.id, ok: true, result: "ok" }))
      expect(yield* Fiber.join(fiber2)).toBe("ok")
    }),
  )

  it.live("tracks hello views and event frames in state", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      yield* bridge.handleFrame(
        JSON.stringify({ type: "hello", client: "desktop", version: "0.0.0", views: [viewState] }),
      )
      let state = yield* bridge.state()
      expect(state.status).toBe("connected")
      expect(state.status === "connected" && state.views).toEqual([viewState])

      const next = { ...viewState, url: "https://example.com/other", title: "Other", loading: true }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.updated", properties: next }))
      state = yield* bridge.state()
      expect(state.status === "connected" && state.views).toEqual([next])
    }),
  )
  it.live("normalizes hello page IDs without conflating shared profiles", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })
      const profileID = "persist:consult-gpt-pro"
      const helloViews = ["consult:one", "consult:two"].map((pageID, index) => ({
        ...viewState,
        pageID,
        partition: "old-wire-alias",
        profileID,
        kind: "consultation",
        owner: { directory: "/repo", sessionID: `ses_${index}` },
        epoch: 1,
      }))
      yield* bridge.handleFrame(JSON.stringify({ type: "hello", client: "desktop", version: "dev", views: helloViews }))
      const state = yield* bridge.state()
      expect(state.status === "connected" && state.views).toEqual(
        helloViews.map((view) => ({ ...view, partition: view.pageID })),
      )
    }),
  )

  it.live("merges browser.updated per pageID instead of replacing the list", () =>
    // Regression (F1): each desktop event describes ONE view; the old
    // `views = [decoded]` collapsed the copy to a single entry whenever the
    // desktop had more than one tab.
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter, views: [viewState] })

      const agent = { ...viewState, partition: "agent-browser-ses_1", url: "https://agent.test/", epoch: 1 }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.updated", properties: agent }))
      const userUpdate = { ...viewState, url: "https://example.com/other", epoch: 2 }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.updated", properties: userUpdate }))

      const state = yield* bridge.state()
      expect(state.status === "connected" && state.views).toEqual([userUpdate, agent])
    }),
  )
  it.live("keeps two pages on one profile distinct and fences stale close events", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      const profileID = "persist:consult-gpt-pro"
      const first = {
        ...viewState,
        pageID: "consult:one",
        partition: "consult:one",
        profileID,
        kind: "consultation" as const,
        owner: { directory: "/repo", sessionID: "ses_one" },
        epoch: 1,
      }
      const second = {
        ...viewState,
        pageID: "consult:two",
        partition: "consult:two",
        profileID,
        kind: "consultation" as const,
        owner: { directory: "/repo", sessionID: "ses_two" },
        epoch: 1,
      }
      yield* bridge.connect({ adapter: fake.adapter, views: [first, second] })

      const secondUpdate = { ...second, url: "https://two.test/", epoch: 2 }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.updated", properties: secondUpdate }))
      yield* bridge.handleFrame(
        JSON.stringify({
          type: "event",
          name: "browser.closed",
          properties: { pageID: "consult:two", partition: "consult:two", profileID, epoch: 1 },
        }),
      )
      let state = yield* bridge.state()
      expect(state.status === "connected" && state.views).toEqual([first, secondUpdate])

      yield* bridge.handleFrame(
        JSON.stringify({
          type: "event",
          name: "browser.closed",
          properties: { pageID: "consult:one", partition: "consult:one", profileID, epoch: 1 },
        }),
      )
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.updated", properties: first }))
      state = yield* bridge.state()
      expect(state.status === "connected" && state.views).toEqual([secondUpdate])

      const secondNext = { ...secondUpdate, epoch: 3, url: "https://two-new.test/" }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.updated", properties: secondNext }))
      state = yield* bridge.state()
      expect(state.status === "connected" && state.views).toEqual([secondNext])
    }),
  )

  it.live("drops stale browser.updated events with an older epoch", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter, views: [{ ...viewState, epoch: 3 }] })

      const stale = { ...viewState, url: "https://stale.test/", epoch: 2 }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.updated", properties: stale }))

      const state = yield* bridge.state()
      expect(state.status === "connected" && state.views).toEqual([{ ...viewState, epoch: 3 }])
    }),
  )

  it.live("removes views on browser.closed events", () =>
    // Regression (F2): the desktop emits browser.closed but the bridge only
    // handled browser.updated/browser.console — closed views stayed in the
    // copy forever.
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const agent = { ...viewState, partition: "agent-browser-ses_1", epoch: 1 }
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter, views: [viewState, agent] })

      yield* bridge.handleFrame(
        JSON.stringify({ type: "event", name: "browser.closed", properties: { partition: agent.partition, epoch: 1 } }),
      )
      const state = yield* bridge.state()
      expect(state.status === "connected" && state.views).toEqual([viewState])
    }),
  )

  it.live("buffers console event frames per pageID", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      const entry = { partition: "persist:browse", level: "error", text: "boom", at: 1234 }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.console", properties: entry }))
      yield* bridge.handleFrame(
        JSON.stringify({
          type: "event",
          name: "browser.console",
          properties: { ...entry, partition: "agent-1", at: 2000 },
        }),
      )

      const all = yield* bridge.console("persist:browse")
      expect(all).toEqual([entry])
      const since = yield* bridge.console("persist:browse", 1234)
      expect(since).toEqual([])

      const profileID = "persist:consult-gpt-pro"
      const first = { ...entry, pageID: "consult:one", partition: "consult:one", profileID, at: 3000 }
      const second = { ...entry, pageID: "consult:two", partition: "consult:two", profileID, at: 4000 }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.console", properties: first }))
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.console", properties: second }))
      expect(yield* bridge.console("consult:one")).toEqual([first])
      expect(yield* bridge.console("consult:two")).toEqual([second])
    }),
  )

  it.live("drops malformed frames without failing the socket", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      yield* bridge.handleFrame("not json at all")
      yield* bridge.handleFrame(JSON.stringify({ type: "unknown" }))
      yield* bridge.handleFrame(JSON.stringify({ type: "resp" }))

      const state = yield* bridge.state()
      expect(state.status).toBe("connected")
    }),
  )

  it.live("publishes page metadata on BrowserUpdated bus events", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter, instance: busTestInstance })

      const received: Array<{ id: string; type: string; properties: unknown }> = []
      const unsubscribe = Bus.subscribe(BrowserUpdated, (event) => received.push(event))

      const page = {
        ...viewState,
        pageID: "consult:one",
        partition: "consult:one",
        profileID: "persist:consult-gpt-pro",
        owner: { directory: "/repo", sessionID: "ses_one" },
        kind: "consultation",
        epoch: 3,
      }
      yield* bridge.handleFrame(JSON.stringify({ type: "event", name: "browser.updated", properties: page }))
      // Bus.publish is fire-and-forget from the bridge; let the module runtime deliver.
      yield* Effect.sleep("200 millis")
      unsubscribe()

      const hit = received.find((event) => event.type === "browser.updated")
      expect(hit).toBeDefined()
      expect(hit && hit.properties).toEqual(page)
    }).pipe(
      // Module-level Bus.subscribe reads InstanceRef from the calling fiber's
      // context; without it the subscribe dies before any event can arrive.
      Effect.provideService(InstanceRef, busTestInstance),
    ),
  )

  it.live("publishes GPT-Pro notification frames for durable background delivery", () =>
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter, instance: busTestInstance })

      const received: Array<{ id: string; type: string; properties: unknown }> = []
      const unsubscribe = Bus.subscribe(GptProNotificationReceived, (event) => received.push(event))
      const notification = {
        id: "gpt_test:notification:1",
        consultationID: "gpt_test",
        owner: `${busTestInstance.directory}\nses_test`,
        phase: "generating",
        revision: 1,
        at: 1234,
        url: "https://chatgpt.com/c/test",
        kind: "progress",
        format: "snapshot",
        text: "Partial answer",
        truncated: false,
      }
      yield* bridge.handleFrame(
        JSON.stringify({ type: "event", name: "gpt-pro.notification", properties: notification }),
      )
      yield* Effect.sleep("200 millis")
      unsubscribe()

      const hit = received.find((event) => event.type === "gpt-pro.notification")
      expect(hit).toBeDefined()
      expect(hit?.properties).toEqual(notification)
    }).pipe(Effect.provideService(InstanceRef, busTestInstance)),
  )

  it.live("keeps the connection alive when an event frame fails schema decode", () =>
    // Regression: a console entry with CDP's native level "warning" (not
    // "warn") used to throw inside publishEvent, crashing the WS read loop
    // and dropping the bridge mid-session (observed live on google.com.hk,
    // 2026-09-29). The invalid frame must be dropped, not fatal.
    Effect.gen(function* () {
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      yield* bridge.handleFrame(
        JSON.stringify({
          type: "event",
          name: "browser.console",
          properties: { partition: "persist:browse", level: "warning", text: "boom", at: 1 },
        }),
      )

      // The connection still round-trips commands after the dropped frame.
      const fiber = yield* bridge.command<string>("navigate", { url: "https://example.com/" }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* respond(bridge, fake, true, { url: "https://example.com/" })
      expect(yield* Fiber.join(fiber)).toEqual({ url: "https://example.com/" })
    }),
  )
})
