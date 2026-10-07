import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Browser } from "../../src/browser"
import { BrowserBridge } from "../../src/browser/bridge"
import { testEffect } from "../lib/effect"
import { InstanceState } from "../../src/effect/instance-state"

// Browser.defaultLayer already provides the bridge internally; the bridge is
// merged in separately only so tests can drive the fake adapter directly.
const it = testEffect(Layer.mergeAll(Browser.defaultLayer, BrowserBridge.defaultLayer))

type FakeAdapter = {
  adapter: BrowserBridge.Adapter
  sent: string[]
}

function fakeAdapter(): FakeAdapter {
  const sent: string[] = []
  return {
    sent,
    adapter: {
      send: (data) => {
        sent.push(data)
      },
      close: () => {},
    },
  }
}

const viewState = {
  partition: "agent-browser-ses_1",
  url: "https://example.com/",
  title: "Example Domain",
  loading: false,
  shared: false,
}

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? (exit.cause as unknown as { reasons?: Array<{ error?: unknown }> }).reasons?.[0]?.error
    : undefined

describe("Browser facade", () => {
  it.instance(
    "routes recovery tools through an owner-scoped consultation broker rather than arbitrary partitions",
    () =>
      Effect.gen(function* () {
        const browser = yield* Browser.Service
        const bridge = yield* BrowserBridge.Service
        const { directory } = yield* InstanceState.context
        const fake = fakeAdapter()
        yield* bridge.connect({ adapter: fake.adapter })
        const fiber = yield* browser.snapshot("ses_owner", { consultationID: "gpt_recovery" }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const frame = JSON.parse(fake.sent[0])
        expect(frame.name).toBe("gpt-pro-browser")
        expect(frame.args).toMatchObject({
          owner: `${directory}\nses_owner`,
          id: "gpt_recovery",
          name: "snapshot",
          args: {},
        })
        expect(frame.args.partition).toBeUndefined()
        yield* bridge.handleFrame(
          JSON.stringify({
            type: "resp",
            id: frame.id,
            ok: true,
            result: { snapshot: { url: "https://chatgpt.com/", title: "Chat", nodes: [] } },
          }),
        )
        expect((yield* Fiber.join(fiber)).url).toBe("https://chatgpt.com/")
      }),
  )
  it.live("fails with a descriptive NotConnectedError when no desktop client is connected", () =>
    Effect.gen(function* () {
      const browser = yield* Browser.Service
      const exit = yield* Effect.exit(browser.navigate("ses_1", "https://example.com/"))
      const failure = failureOf(exit)
      expect(failure).toBeInstanceOf(Browser.NotConnectedError)
      const message = (failure as Error).message
      expect(message).toContain("desktop app")
      expect(message).toContain("browser bridge")
    }),
  )

  it.live("routes commands to the per-session agent partition", () =>
    Effect.gen(function* () {
      const browser = yield* Browser.Service
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      const fiber = yield* browser.navigate("ses_1", "https://example.com/").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const frame = JSON.parse(fake.sent[0])
      expect(frame.name).toBe("navigate")
      expect(frame.args.partition).toBe("agent-browser-ses_1")
      expect(frame.args.url).toBe("https://example.com/")

      // A second session maps to a different partition.
      const fiber2 = yield* browser.snapshot("ses_2").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const frame2 = JSON.parse(fake.sent[1])
      expect(frame2.name).toBe("snapshot")
      expect(frame2.args.partition).toBe("agent-browser-ses_2")
      expect(frame2.args.partition).not.toBe(frame.args.partition)

      yield* bridge.handleFrame(JSON.stringify({ type: "resp", id: frame.id, ok: true, result: { state: viewState } }))
      const state = yield* Fiber.join(fiber)
      expect(state).toEqual(viewState)

      yield* bridge.handleFrame(
        JSON.stringify({
          type: "resp",
          id: frame2.id,
          ok: true,
          result: { snapshot: { url: viewState.url, title: viewState.title, nodes: [] } },
        }),
      )
      const snapshot = yield* Fiber.join(fiber2)
      expect(snapshot.nodes).toEqual([])
    }),
  )

  it.live("decodes screenshot and click responses", () =>
    Effect.gen(function* () {
      const browser = yield* Browser.Service
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter })

      const shot = yield* browser.screenshot("ses_1", { fullPage: true }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const shotFrame = JSON.parse(fake.sent[0])
      expect(shotFrame.args.fullPage).toBe(true)
      yield* bridge.handleFrame(
        JSON.stringify({ type: "resp", id: shotFrame.id, ok: true, result: { data: "cHdu", mime: "image/png" } }),
      )
      expect(yield* Fiber.join(shot)).toEqual({ data: "cHdu", mime: "image/png" })

      const click = yield* browser.click("ses_1", "n123").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const clickFrame = JSON.parse(fake.sent[1])
      expect(clickFrame.args.uid).toBe("n123")
      yield* bridge.handleFrame(
        JSON.stringify({
          type: "resp",
          id: clickFrame.id,
          ok: true,
          result: { point: { x: 1, y: 2 }, state: viewState },
        }),
      )
      expect(yield* Fiber.join(click)).toEqual(viewState)
    }),
  )

  it.live("delivers console entries incrementally per session", () =>
    Effect.gen(function* () {
      const browser = yield* Browser.Service
      const bridge = yield* BrowserBridge.Service
      const fake = fakeAdapter()
      yield* bridge.connect({ adapter: fake.adapter, instance: undefined })

      const entry = (partition: string, at: number) => ({
        partition,
        level: "error" as const,
        text: `boom ${at}`,
        at,
      })
      yield* bridge.handleFrame(
        JSON.stringify({ type: "event", name: "browser.console", properties: entry("agent-browser-ses_1", 100) }),
      )
      yield* bridge.handleFrame(
        JSON.stringify({ type: "event", name: "browser.console", properties: entry("agent-browser-ses_1", 200) }),
      )

      const first = yield* browser.console("ses_1")
      expect(first).toHaveLength(2)

      // No new entries: incremental cursor advanced.
      const second = yield* browser.console("ses_1")
      expect(second).toEqual([])

      // Explicit since overrides the cursor.
      const explicit = yield* browser.console("ses_1", { since: 0 })
      expect(explicit).toHaveLength(2)

      // Other sessions have their own cursor.
      yield* bridge.handleFrame(
        JSON.stringify({ type: "event", name: "browser.console", properties: entry("agent-browser-ses_2", 300) }),
      )
      const other = yield* browser.console("ses_2")
      expect(other).toHaveLength(1)
    }),
  )
})
