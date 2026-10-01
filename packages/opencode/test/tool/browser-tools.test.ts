import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Browser } from "../../src/browser"
import { BrowserBridge } from "../../src/browser/bridge"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { BrowserNavigateTool } from "../../src/tool/browser_navigate"
import { BrowserReadTool } from "../../src/tool/browser_read"
import { BrowserClickTool } from "../../src/tool/browser_click"
import { BrowserTypeTool } from "../../src/tool/browser_type"
import { BrowserScrollTool } from "../../src/tool/browser_scroll"
import { BrowserScreenshotTool } from "../../src/tool/browser_screenshot"
import { BrowserConsoleTool } from "../../src/tool/browser_console"
import { BrowserCloseTool } from "../../src/tool/browser_close"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, Browser.defaultLayer, BrowserBridge.defaultLayer),
)

const viewState = {
  partition: "agent-browser-ses_browser",
  url: "http://localhost:4000/form",
  title: "Fixture Form",
  loading: false,
  shared: false,
}

type AskCall = { permission: string; patterns: readonly string[] }

function makeCtx(askCalls: AskCall[], ask: (call: AskCall) => Effect.Effect<void, unknown> = () => Effect.void) {
  return {
    sessionID: SessionID.make("ses_browser"),
    messageID: MessageID.make("msg_message"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input: { permission: string; patterns: readonly string[] }) => {
      askCalls.push(input)
      return ask(input)
    },
  } as unknown as Tool.Context
}

type FakeAdapter = { adapter: BrowserBridge.Adapter; sent: Array<Record<string, unknown>> }

/**
 * Mock desktop side. Answers the facade's `state` probes immediately so
 * requireState passes; tool commands stay pending for explicit responses.
 */
function fakeAdapter(bridge: BrowserBridge.Interface): FakeAdapter {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    adapter: {
      send: (data) => {
        const frame = JSON.parse(data) as Record<string, unknown>
        sent.push(frame)
        if (frame.name === "state") {
          void Effect.runPromise(
            bridge.handleFrame(
              JSON.stringify({ type: "resp", id: frame.id, ok: true, result: { state: viewState } }),
            ),
          ).catch(() => undefined)
        }
      },
      close: () => {},
    },
  }
}

const respond = (bridge: BrowserBridge.Interface, fake: FakeAdapter, ok: boolean, result: unknown) => {
  const frame = fake.sent.at(-1)!
  return bridge.handleFrame(JSON.stringify({ type: "resp", id: frame.id as string, ok, result }))
}

const exec = Effect.fn("BrowserToolsTest.exec")(function* (
  info: { init: () => Effect.Effect<{ execute: (args: never, ctx: Tool.Context) => Effect.Effect<unknown> }> },
  args: Record<string, unknown>,
  ctx: Tool.Context,
) {
  const def = yield* info
  const tool = yield* def.init()
  return yield* tool.execute(args as never, ctx)
})

describe("tool.browser_*", () => {
  it.instance(
    "browser_navigate asks for the URL permission and returns page info",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })
        const askCalls: AskCall[] = []

        const fiber = yield* Effect.forkChild(
          exec(BrowserNavigateTool, { url: "http://localhost:4000/form" }, makeCtx(askCalls)),
        )
        yield* Effect.yieldNow
        expect(askCalls).toHaveLength(1)
        expect(askCalls[0].permission).toBe("browser_navigate")
        expect(askCalls[0].patterns).toEqual(["http://localhost:4000/form"])

        yield* respond(bridge, fake, true, { state: viewState })
        const result = (yield* Fiber.join(fiber)) as { output: string; metadata: Record<string, unknown> }
        expect(result.output).toContain("http://localhost:4000/form")
        expect(result.metadata.title).toBe("Fixture Form")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_navigate surfaces permission deny without sending any bridge command",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })

        const fiber = yield* Effect.forkChild(
          exec(
            BrowserNavigateTool,
            { url: "http://localhost:4000/secret" },
            makeCtx([], () => Effect.fail(new Error("denied by user"))),
          ),
        )
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        // Only the facade's state probe ran; the navigation itself was blocked.
        expect(fake.sent.every((frame) => frame.name === "state")).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_read formats the snapshot with uids and asks with the page url",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })
        const askCalls: AskCall[] = []

        const fiber = yield* Effect.forkChild(exec(BrowserReadTool, {}, makeCtx(askCalls)))
        yield* Effect.yieldNow
        expect(askCalls[0].patterns).toEqual([viewState.url])

        yield* respond(bridge, fake, true, {
          snapshot: {
            url: viewState.url,
            title: viewState.title,
            nodes: [
              { uid: "n10", role: "textbox", name: "Email" },
              { uid: "n11", role: "button", name: "Sign in" },
            ],
          },
        })
        const result = (yield* Fiber.join(fiber)) as { output: string; metadata: Record<string, unknown> }
        expect(result.output).toContain('[n10] textbox "Email"')
        expect(result.output).toContain('[n11] button "Sign in"')
        expect(result.metadata.nodes).toBe(2)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_click reports the post-interaction url when navigation happens",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })

        const fiber = yield* Effect.forkChild(exec(BrowserClickTool, { uid: "n11" }, makeCtx([])))
        yield* Effect.yieldNow
        yield* respond(bridge, fake, true, {
          point: { x: 1, y: 2 },
          state: { ...viewState, url: "http://localhost:4000/done", title: "Done" },
        })
        const result = (yield* Fiber.join(fiber)) as { output: string; metadata: Record<string, unknown> }
        expect(result.output).toContain("navigated to a new page")
        expect(result.metadata.url).toBe("http://localhost:4000/done")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_type passes submit through and reports the landing page",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })

        const fiber = yield* Effect.forkChild(
          exec(BrowserTypeTool, { uid: "n10", text: "agent@example.com", submit: true }, makeCtx([])),
        )
        yield* Effect.yieldNow
        const frame = fake.sent.at(-1)!
        expect(frame.args).toMatchObject({ text: "agent@example.com", submit: true })
        yield* respond(bridge, fake, true, {
          typed: 18,
          url: "http://localhost:4000/done",
          state: { ...viewState, url: "http://localhost:4000/done", title: "Done" },
        })
        const result = (yield* Fiber.join(fiber)) as { metadata: Record<string, unknown> }
        expect(result.metadata.url).toBe("http://localhost:4000/done")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_scroll wheels the page and reports the current url",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })
        const askCalls: AskCall[] = []

        const fiber = yield* Effect.forkChild(
          exec(BrowserScrollTool, { direction: "up", amount: 400 }, makeCtx(askCalls)),
        )
        yield* Effect.yieldNow
        expect(askCalls[0].permission).toBe("browser_scroll")
        expect(askCalls[0].patterns).toEqual([viewState.url])

        const frame = fake.sent.at(-1)!
        expect(frame.name).toBe("scroll")
        expect(frame.args).toMatchObject({ partition: "agent-browser-ses_browser", direction: "up", amount: 400 })
        yield* respond(bridge, fake, true, { state: viewState })
        const result = (yield* Fiber.join(fiber)) as { output: string; metadata: Record<string, unknown> }
        expect(result.output).toContain("Scrolled up by 400px.")
        expect(result.output).toContain(`Current page: ${viewState.url}`)
        expect(result.metadata.url).toBe(viewState.url)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_scroll centers a uid and ignores the wheel arguments",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })

        const fiber = yield* Effect.forkChild(exec(BrowserScrollTool, { uid: "n11" }, makeCtx([])))
        yield* Effect.yieldNow
        expect(fake.sent.at(-1)!.args).toMatchObject({ uid: "n11" })
        yield* respond(bridge, fake, true, { state: viewState })
        const result = (yield* Fiber.join(fiber)) as { output: string }
        expect(result.output).toContain("Scrolled element n11 into view.")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_screenshot returns a png attachment",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })

        const fiber = yield* Effect.forkChild(exec(BrowserScreenshotTool, { fullPage: true }, makeCtx([])))
        yield* Effect.yieldNow
        const frame = fake.sent.at(-1)!
        expect(frame.args).toMatchObject({ fullPage: true })
        yield* respond(bridge, fake, true, { data: "cHdu", mime: "image/png" })
        const result = (yield* Fiber.join(fiber)) as { attachments: Array<{ mime: string }> }
        expect(result.attachments?.[0]?.mime).toBe("image/png")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_console groups errors and warnings and is incremental",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })

        const consoleEvent = (level: "error" | "warn", text: string, at: number) =>
          bridge.handleFrame(
            JSON.stringify({
              type: "event",
              name: "browser.console",
              properties: { partition: "agent-browser-ses_browser", level, text, at },
            }),
          )
        yield* consoleEvent("error", "boom", 100)
        yield* consoleEvent("warn", "meh", 110)

        const fiber = yield* Effect.forkChild(exec(BrowserConsoleTool, {}, makeCtx([])))
        yield* Effect.yieldNow
        yield* respond(bridge, fake, true, { state: viewState })
        const result = (yield* Fiber.join(fiber)) as { output: string; metadata: Record<string, unknown> }
        expect(result.output).toContain("[error] boom")
        expect(result.output).toContain("[warn] meh")
        expect(result.metadata.errors).toBe(1)

        // Incremental: nothing new since the last read.
        const fiber2 = yield* Effect.forkChild(exec(BrowserConsoleTool, {}, makeCtx([])))
        yield* Effect.yieldNow
        yield* respond(bridge, fake, true, { state: viewState })
        const result2 = (yield* Fiber.join(fiber2)) as { output: string }
        expect(result2.output).toContain("No new console entries.")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "browser_close sends the agent partition close command and reports success",
    () =>
      Effect.gen(function* () {
        const bridge = yield* BrowserBridge.Service
        const fake = fakeAdapter(bridge)
        yield* bridge.connect({ adapter: fake.adapter })
        const askCalls: AskCall[] = []

        const fiber = yield* Effect.forkChild(exec(BrowserCloseTool, {}, makeCtx(askCalls)))
        yield* Effect.yieldNow
        expect(askCalls).toHaveLength(1)
        expect(askCalls[0].permission).toBe("browser_close")

        const frame = fake.sent.at(-1)!
        expect(frame.name).toBe("close")
        expect(frame.args).toMatchObject({ partition: "agent-browser-ses_browser" })
        yield* respond(bridge, fake, true, {})
        const result = (yield* Fiber.join(fiber)) as { output: string }
        expect(result.output).toContain("Closed this session's embedded browser tab.")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
