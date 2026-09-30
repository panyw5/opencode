import { BrowserBridge } from "@/browser/bridge"
import { BrowserTicket } from "@/browser/ticket"
import { EffectBridge } from "@/effect/bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "@/server/cors"
import {
  BROWSER_BRIDGE_TICKET_QUERY,
  BROWSER_BRIDGE_TOKEN_HEADER,
  BROWSER_BRIDGE_TOKEN_HEADER_VALUE,
} from "@/server/shared/browser-bridge-ticket"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import { WebSocketTracker } from "../websocket-tracker"
import { WorkspaceRoutingQuery } from "../middleware/workspace-routing"

function validOrigin(request: HttpServerRequest.HttpServerRequest, opts: CorsOptions | undefined) {
  return isAllowedRequestOrigin(request.headers.origin, request.headers.host, opts)
}

export const browserHandlers = HttpApiBuilder.group(InstanceHttpApi, "browser", (handlers) =>
  Effect.gen(function* () {
    const tickets = yield* BrowserTicket.Service
    const cors = yield* CorsConfig

    const connectToken = Effect.fn("BrowserHttpApi.connectToken")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (
        request.headers[BROWSER_BRIDGE_TOKEN_HEADER] !== BROWSER_BRIDGE_TOKEN_HEADER_VALUE ||
        !validOrigin(request, cors)
      )
        return yield* new ApiError.BrowserForbiddenError({ message: "Invalid browser bridge token request" })
      return yield* tickets.issue(yield* BrowserTicket.scope)
    })

    return handlers.handle("connectToken", connectToken)
  }),
)

export const browserConnectRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge.Service
    const tickets = yield* BrowserTicket.Service
    const cors = yield* CorsConfig
    yield* router.add(
      "GET",
      "/browser/bridge",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const ticket = new URL(request.url, "http://localhost").searchParams.get(BROWSER_BRIDGE_TICKET_QUERY)
        if (ticket) {
          const valid = validOrigin(request, cors)
            ? yield* tickets.consume({ ticket, ...(yield* BrowserTicket.scope) })
            : false
          if (!valid) return HttpServerResponse.empty({ status: 403 })
        }

        const socket = yield* Effect.orDie(request.upgrade)
        const write = yield* socket.writer
        const eb = yield* EffectBridge.make()
        const writeScoped = (effect: Effect.Effect<void, unknown>) => {
          eb.fork(effect.pipe(Effect.catch(() => Effect.void)))
        }
        let closed = false
        const adapter = {
          get readyState() {
            return closed ? 3 : 1
          },
          send: (data: string | Uint8Array | ArrayBuffer) => {
            if (closed) return
            writeScoped(write(data instanceof ArrayBuffer ? new Uint8Array(data) : data))
          },
          close: (code?: number, reason?: string) => {
            if (closed) return
            closed = true
            writeScoped(write(new Socket.CloseEvent(code, reason)))
          },
        }

        const registered = yield* WebSocketTracker.register(write(WebSocketTracker.SERVER_CLOSING_EVENT()))
        if (!registered) {
          adapter.close()
          return HttpServerResponse.empty()
        }

        const instance = yield* InstanceRef
        yield* bridge.connect({ adapter, instance: instance ?? undefined })

        yield* socket
          .runRaw((message) => decodeBridgeFrame(bridge, message))
          .pipe(
            Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
            Effect.ensuring(Effect.sync(() => void bridge.disconnect())),
            Effect.orDie,
          )
        return HttpServerResponse.empty()
      }),
    )
  }),
)

const inputDecoder = new TextDecoder("utf-8", { fatal: true })

function decodeBridgeFrame(bridge: BrowserBridge.Interface, message: string | Uint8Array) {
  if (typeof message === "string") return bridge.handleFrame(message)
  return Effect.try({
    try: () => inputDecoder.decode(message),
    catch: () => new Error("invalid browser bridge websocket input"),
  }).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.flatMap((decoded) => (decoded === undefined ? Effect.void : bridge.handleFrame(decoded))),
  )
}
