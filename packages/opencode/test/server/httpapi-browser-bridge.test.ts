import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Bus } from "../../src/bus"
import { BrowserBridge } from "../../src/browser/bridge"
import { Server } from "../../src/server/server"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Config, Effect, Fiber, Layer, Queue, Schema } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import * as Log from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"

void Log.init({ print: false })

const BRIDGE_ROOT = "/browser/bridge"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await resetDatabase()
      }),
    )
  }),
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const effectIt = testEffectShared(
  Layer.mergeAll(
    testStateLayer,
    Socket.layerWebSocketConstructorGlobal,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
    Bus.defaultLayer,
    BrowserBridge.defaultLayer,
  ),
)

function app() {
  return Server.Default().app
}

function serverUrl() {
  return HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))
}

const directoryHeader = (dir: string) => ({ "x-opencode-directory": dir })

const readEvent = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => reader.read()).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    if (result.done || !result.value) return yield* Effect.fail(new Error("event stream closed"))
    return JSON.parse(new TextDecoder().decode(result.value).replace(/^data: /, "")) as {
      id?: string
      type: string
      properties: unknown
    }
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      app().request(EventPaths.event, { headers: directoryHeader(directory) }),
    )
    if (!response.body) return yield* Effect.die("missing SSE response body")
    const reader = response.body.getReader()
    yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel().catch(() => undefined)))
    return { response, reader }
  })

const issueTicket = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      app().request(`${BRIDGE_ROOT}/ticket`, {
        method: "POST",
        headers: { ...directoryHeader(directory), "x-opencode-ticket": "1" },
      }),
    )
    expect(response.status).toBe(200)
    return (yield* Effect.promise(() => response.json())) as { ticket: string; expires_in: number }
  })

const viewState = {
  partition: "persist:browse",
  url: "https://example.com/",
  title: "Example Domain",
  loading: false,
  shared: false,
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("browser bridge HttpApi", () => {
  effectIt.live("issues a connect token for authenticated requests", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })

      const forbidden = yield* Effect.promise(() =>
        app().request(`${BRIDGE_ROOT}/ticket`, { method: "POST", headers: directoryHeader(dir) }),
      )
      expect(forbidden.status).toBe(403)
      expect(yield* Effect.promise(() => forbidden.json())).toMatchObject({ _tag: "BrowserForbiddenError" })

      const token = yield* issueTicket(dir)
      expect(typeof token.ticket).toBe("string")
      expect(token.ticket.length).toBeGreaterThan(0)
      expect(token.expires_in).toBeGreaterThan(0)
    }),
  )

  effectIt.live("rejects the websocket route for an invalid ticket", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      const response = yield* Effect.promise(() =>
        app().request(`${BRIDGE_ROOT}?ticket=bogus&directory=${encodeURIComponent(dir)}`, {
          headers: directoryHeader(dir),
        }),
      )
      expect(response.status).toBe(403)
    }),
  )

  effectIt.live("round-trips commands and forwards bridge events to the event stream over websocket", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })

      const { reader } = yield* openEventStream(dir)
      expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

      const { ticket } = yield* issueTicket(dir)
      const url = yield* serverUrl()
      const socket = yield* Socket.makeWebSocket(
        `${url.replace(/^http/, "ws")}${BRIDGE_ROOT}?ticket=${encodeURIComponent(ticket)}&directory=${encodeURIComponent(dir)}`,
        { closeCodeIsError: () => false },
      )
      const messages = yield* Queue.unbounded<string>()
      yield* socket
        .runRaw((message) =>
          Queue.offer(messages, typeof message === "string" ? message : new TextDecoder().decode(message)),
        )
        .pipe(Effect.catch(() => Effect.void), Effect.forkScoped)
      const write = yield* socket.writer

      const bridge = yield* BrowserBridge.Service
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const state = yield* bridge.state()
          return state.status === "connected" ? state : undefined
        }),
        "bridge did not register the websocket client",
      )

      yield* write(JSON.stringify({ type: "hello", client: "desktop-test", version: "0.0.0" })).pipe(
        Effect.catch(() => Effect.void),
      )
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const state = yield* bridge.state()
          return state.status === "connected" && state.client?.kind === "desktop-test" ? state : undefined
        }),
        "bridge did not record hello",
      )

      // server -> client: a bridge.command must arrive as a cmd frame and the
      // resp frame must resolve the pending command.
      const fiber = yield* bridge
        .command<{ ok: boolean }>("navigate", { url: "https://example.com/" }, { timeout: "5 seconds" })
        .pipe(Effect.forkChild)
      const frame = JSON.parse(yield* Queue.take(messages).pipe(Effect.timeout("5 seconds")))
      expect(frame.type).toBe("cmd")
      expect(frame.name).toBe("navigate")
      expect(frame.args).toEqual({ url: "https://example.com/" })
      yield* write(JSON.stringify({ type: "resp", id: frame.id, ok: true, result: { ok: true } })).pipe(
        Effect.catch(() => Effect.void),
      )
      expect(yield* Fiber.join(fiber)).toEqual({ ok: true })

      // client -> server: an event frame must reach the SSE stream.
      yield* write(JSON.stringify({ type: "event", name: "browser.updated", properties: viewState })).pipe(
        Effect.catch(() => Effect.void),
      )
      const event = yield* readEvent(reader)
      expect(event.type).toBe("browser.updated")
      expect(event.properties).toEqual(viewState)

      yield* write(new Socket.CloseEvent(1000, "done")).pipe(Effect.catch(() => Effect.void))
    }),
  )
})
