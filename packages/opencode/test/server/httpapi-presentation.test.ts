import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { removeSessionArtifacts, snapshot } from "../../src/session/presentation"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const routes: Layer.Layer<never, never, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})
const server = routes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(server)
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+JQ7nNwAAAABJRU5ErkJggg==",
    "base64",
  ),
)

describe("presentation HTTP route", () => {
  it.live("serves session-owned image bytes and rejects invalid session or artifact lookups", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => resetDatabase())
      yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
      const directory = yield* tmpdirScoped({ git: true })
      const created = yield* HttpClientRequest.post(SessionPaths.create).pipe(
        HttpClientRequest.setHeader("x-opencode-directory", directory),
        HttpClientRequest.bodyJson({ title: "presentation-route-test" }),
        Effect.flatMap(HttpClient.execute),
      )
      expect(created.status).toBe(200)
      const session = (yield* created.json) as { id: string }
      yield* Effect.addFinalizer(() => Effect.promise(() => removeSessionArtifacts(session.id)))

      const source = path.join(directory, "proof.png")
      yield* Effect.promise(() => writeFile(source, png))
      const artifact = yield* Effect.promise(() =>
        snapshot({ sessionID: session.id, sourcePath: source, purpose: "verification" }),
      )
      const url = `/session/${session.id}/presentation/${artifact.artifactID}?variant=thumbnail`
      const response = yield* HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("x-opencode-directory", directory),
        HttpClient.execute,
      )
      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("image/png")
      expect(response.headers["cache-control"]).toContain("immutable")
      expect(response.headers["x-content-type-options"]).toBe("nosniff")
      expect(new Uint8Array(yield* response.arrayBuffer).slice(0, 8)).toEqual(png.slice(0, 8))

      const svgSource = path.join(directory, "flow.svg")
      yield* Effect.promise(() =>
        writeFile(svgSource, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>'),
      )
      const svg = yield* Effect.promise(() =>
        snapshot({ sessionID: session.id, sourcePath: svgSource, purpose: "diagram" }),
      )
      const svgResponse = yield* HttpClientRequest.get(
        `/session/${session.id}/presentation/${svg.artifactID}?variant=thumbnail`,
      ).pipe(HttpClientRequest.setHeader("x-opencode-directory", directory), HttpClient.execute)
      expect(svgResponse.status).toBe(200)
      expect(svgResponse.headers["content-type"]).toContain("image/svg+xml")
      expect(yield* svgResponse.text).toContain("<svg")

      const denied = yield* HttpClientRequest.get(
        `/session/ses_missing/presentation/${artifact.artifactID}?variant=thumbnail`,
      ).pipe(HttpClientRequest.setHeader("x-opencode-directory", directory), HttpClient.execute)
      expect(denied.status).toBe(404)
      const invalid = yield* HttpClientRequest.get(
        `/session/${session.id}/presentation/not-an-artifact?variant=original`,
      ).pipe(HttpClientRequest.setHeader("x-opencode-directory", directory), HttpClient.execute)
      expect(invalid.status).toBe(404)
    }),
    15_000,
  )
})
