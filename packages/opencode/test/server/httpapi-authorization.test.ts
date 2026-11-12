import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/unstable/httpapi"
import { ServerAuth } from "../../src/server/auth"
import {
  Authorization,
  authorizationLayer,
  V2Authorization,
  v2AuthorizationLayer,
} from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { testEffect } from "../lib/effect"

const Api = HttpApi.make("test-authorization").add(
  HttpApiGroup.make("test")
    .add(
      HttpApiEndpoint.get("probe", "/probe", {
        success: Schema.String,
      }),
      HttpApiEndpoint.get("missing", "/missing", {
        success: Schema.String,
        error: HttpApiError.NotFound,
      }),
    )
    .middleware(Authorization),
)

const V2Api = HttpApi.make("test-v2-authorization").add(
  HttpApiGroup.make("test.v2")
    .add(
      HttpApiEndpoint.get("probe", "/api/probe", {
        success: Schema.String,
      }),
    )
    .middleware(V2Authorization),
)

const handlers = HttpApiBuilder.group(Api, "test", (handlers) =>
  handlers
    .handle("probe", () => Effect.succeed("ok"))
    .handle("missing", () => Effect.fail(new HttpApiError.NotFound({}))),
)

const v2Handlers = HttpApiBuilder.group(V2Api, "test.v2", (handlers) =>
  handlers.handle("probe", () => Effect.succeed("ok")),
)

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), Layer.provide(authorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const v2ApiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(V2Api).pipe(Layer.provide(v2Handlers), Layer.provide(v2AuthorizationLayer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest))

const noAuthLayer = ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })
const secretLayer = ServerAuth.Config.layer({ password: Option.some("secret"), username: "opencode" })
const kitSecretLayer = ServerAuth.Config.layer({ password: Option.some("secret"), username: "kit" })
const urlSafeSecretLayer = ServerAuth.Config.layer({ password: Option.some("se?cr~et"), username: "opencode" })
const colonSecretLayer = ServerAuth.Config.layer({ password: Option.some("sec:ret"), username: "opencode" })

const it = testEffect(apiLayer.pipe(Layer.provide(noAuthLayer)))
const itSecret = testEffect(apiLayer.pipe(Layer.provide(secretLayer)))
const itKitSecret = testEffect(apiLayer.pipe(Layer.provide(kitSecretLayer)))
const itUrlSafeSecret = testEffect(apiLayer.pipe(Layer.provide(urlSafeSecretLayer)))
const itColonSecret = testEffect(apiLayer.pipe(Layer.provide(colonSecretLayer)))
const itV2Secret = testEffect(v2ApiLayer.pipe(Layer.provide(secretLayer)))

const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""

const token = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64")

const tokenUrl = (username: string, password: string) => Buffer.from(`${username}:${password}`).toString("base64url")

const getProbe = (headers?: Record<string, string>) =>
  HttpClientRequest.get("/probe").pipe(
    headers ? HttpClientRequest.setHeaders(headers) : (request) => request,
    HttpClient.execute,
  )

describe("HttpApi authorization middleware", () => {
  it.live("allows requests when server password is not configured", () =>
    Effect.gen(function* () {
      const response = yield* getProbe()

      expect(response.status).toBe(200)
      expect(yield* response.json).toBe("ok")
    }),
  )

  itSecret.live("requires configured password for basic auth", () =>
    Effect.gen(function* () {
      const [missing, badPassword, good] = yield* Effect.all(
        [
          getProbe(),
          getProbe({ authorization: basic("opencode", "wrong") }),
          getProbe({ authorization: basic("opencode", "secret") }),
        ],
        { concurrency: "unbounded" },
      )

      expect(missing.status).toBe(401)
      expect(missing.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(badPassword.status).toBe(401)
      expect(badPassword.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(good.status).toBe(200)
    }),
  )

  itKitSecret.live("respects configured basic auth username", () =>
    Effect.gen(function* () {
      const [defaultUser, configuredUser] = yield* Effect.all(
        [getProbe({ authorization: basic("opencode", "secret") }), getProbe({ authorization: basic("kit", "secret") })],
        { concurrency: "unbounded" },
      )

      expect(defaultUser.status).toBe(401)
      expect(configuredUser.status).toBe(200)
    }),
  )

  itSecret.live("accepts auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("opencode", "secret"))}`)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("prefers auth token query credentials over basic auth", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(
        `/probe?auth_token=${encodeURIComponent(token("opencode", "secret"))}`,
      ).pipe(HttpClientRequest.setHeader("authorization", basic("opencode", "wrong")), HttpClient.execute)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("preserves handler errors when basic auth succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/missing").pipe(
        HttpClientRequest.setHeader("authorization", basic("opencode", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("preserves handler errors when auth token query succeeds", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/missing?auth_token=${encodeURIComponent(token("opencode", "secret"))}`)

      expect(response.status).toBe(404)
    }),
  )

  itSecret.live("rejects malformed auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/probe?auth_token=not-base64")

      expect(response.status).toBe(401)
    }),
  )

  itUrlSafeSecret.live("accepts unpadded urlsafe auth token query credentials with - and _ characters", () =>
    Effect.gen(function* () {
      // "opencode:se?cr~et" as unpadded base64url containing both "-" and "_"
      const response = yield* HttpClient.get("/probe?auth_token=b3BlbmNvZGU6c2U_Y3J-ZXQ")

      expect(response.status).toBe(200)
    }),
  )

  itUrlSafeSecret.live("accepts standard strict auth token query credentials for the same credential", () =>
    Effect.gen(function* () {
      // the same credential as standard base64 with + / and padding
      const response = yield* HttpClient.get("/probe?auth_token=b3BlbmNvZGU6c2U%2FY3J%2BZXQ%3D")

      expect(response.status).toBe(200)
    }),
  )

  itColonSecret.live("splits auth token query credentials at the first colon so passwords may contain colons", () =>
    Effect.gen(function* () {
      const [urlsafe, strict] = yield* Effect.all(
        [
          HttpClient.get(`/probe?auth_token=${encodeURIComponent(tokenUrl("opencode", "sec:ret"))}`),
          HttpClient.get(`/probe?auth_token=${encodeURIComponent(token("opencode", "sec:ret"))}`),
        ],
        { concurrency: "unbounded" },
      )

      expect(urlsafe.status).toBe(200)
      expect(strict.status).toBe(200)
    }),
  )

  itColonSecret.live("splits basic auth credentials at the first colon so passwords may contain colons", () =>
    Effect.gen(function* () {
      const response = yield* getProbe({ authorization: basic("opencode", "sec:ret") })

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("rejects wrong-password urlsafe auth token query credentials", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(`/probe?auth_token=${encodeURIComponent(tokenUrl("opencode", "wrong"))}`)

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
    }),
  )

  itSecret.live("rejects auth token query credentials that decode without a colon separator", () =>
    Effect.gen(function* () {
      // base64 of "nocolon" decodes cleanly but has no "user:password" shape
      const response = yield* HttpClient.get("/probe?auth_token=bm9jb2xvbg%3D%3D")

      expect(response.status).toBe(401)
    }),
  )

  itSecret.live("does not fall back to basic auth when auth token query cannot be decoded", () =>
    Effect.gen(function* () {
      // 5 characters: invalid length for both standard and urlsafe base64
      const response = yield* HttpClientRequest.get("/probe?auth_token=b3Blb").pipe(
        HttpClientRequest.setHeader("authorization", basic("opencode", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(401)
    }),
  )

  itUrlSafeSecret.live("prefers urlsafe auth token query credentials over basic auth", () =>
    Effect.gen(function* () {
      // unpadded base64url token that standard strict decoding cannot accept
      const response = yield* HttpClientRequest.get(
        `/probe?auth_token=${encodeURIComponent(tokenUrl("opencode", "se?cr~et"))}`,
      ).pipe(HttpClientRequest.setHeader("authorization", basic("opencode", "wrong")), HttpClient.execute)

      expect(response.status).toBe(200)
    }),
  )

  itSecret.live("falls back to basic auth when auth token query is empty", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get("/probe?auth_token=").pipe(
        HttpClientRequest.setHeader("authorization", basic("opencode", "secret")),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
    }),
  )

  itV2Secret.live("returns bodyful v2 unauthorized errors", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/api/probe")
      const body = yield* response.json

      expect(response.status).toBe(401)
      expect(response.headers["www-authenticate"] ?? "").toContain("Basic")
      expect(body).toEqual({ _tag: "UnauthorizedError", message: "Authentication required" })
    }),
  )
})
