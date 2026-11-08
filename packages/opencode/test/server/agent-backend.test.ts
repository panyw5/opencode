import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Server } from "@/server/server"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
describe("ACP management API", () => {
  it.instance("inspects without installing, rejects unreviewed releases and reports authentication separately", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const request = (route: string, body?: unknown) =>
        Effect.promise(async () => {
          const response = await Server.Default().app.request(route, {
            method: body === undefined ? "GET" : "POST",
            headers: { "x-opencode-directory": instance.directory, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          return { status: response.status, body: (await response.json()) as any }
        })
      const status = yield* request("/agent-backend")
      expect(status.status).toBe(200)
      expect(status.body.target).toBeTruthy()
      expect(status.body.adapters.map((item: { advisor: string }) => item.advisor)).toEqual(["claude", "codex", "pi"])
      const prepared = yield* request("/agent-backend/prepare", {
        advisor: "codex",
        version: "2.5.0",
        action: "install",
      })
      expect(prepared.status).toBe(200)
      expect(prepared.body.integrity).toMatch(/^sha512-/)
      const unchanged = yield* request("/agent-backend")
      expect(unchanged.body.adapters).toEqual(status.body.adapters)
      expect(
        (yield* request("/agent-backend/prepare", { advisor: "codex", version: "latest", action: "install" })).status,
      ).toBe(400)
      expect((yield* request("/agent-backend/commit", { token: "not-a-confirmation" })).status).toBe(400)
      const probe = yield* request("/agent-backend/probe", {
        advisor: "claude",
        config: {
          type: "acp",
          command: [process.execPath, `${import.meta.dir}/../fixture/acp-agent.mjs`],
          env: { ACP_FIXTURE_AUTH: "1" },
        },
      })
      expect(probe.status).toBe(200)
      expect(probe.body).toMatchObject({ status: "authentication_required", authMethods: [{ id: "fixture-login" }] })
      expect((yield* request("/agent-backend/probe", { advisor: "claude", config: { type: "cli-json" } })).status).toBe(
        400,
      )
    }),
  )
})
