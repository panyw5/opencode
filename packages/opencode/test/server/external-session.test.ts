import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "@/server/server"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

describe("external child session HTTP API", () => {
  it.instance(
    "imports once, remains read-only, and rejects ordinary session mutation routes",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const instance = yield* TestInstance
        const parent = yield* sessions.create()
        const messageID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: messageID,
          sessionID: parent.id,
          role: "user",
          agent: "build",
          time: { created: Date.now() },
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        })
        const partID = PartID.ascending()
        yield* sessions.updatePart({
          id: partID,
          messageID,
          sessionID: parent.id,
          type: "tool",
          tool: "claude_consult",
          callID: "history-call",
          state: {
            status: "completed",
            input: { prompt: "Historical question" },
            title: "Claude",
            output: "Historical answer",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        const request = (path: string, body: unknown) =>
          Effect.promise(() =>
            Promise.resolve(
              Server.Default().app.request(path, {
                method: "POST",
                headers: { "x-opencode-directory": instance.directory, "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
            ),
          )
        const first = yield* request(`/session/${parent.id}/external-session`, { messageID, partID })
        expect(first.status).toBe(200)
        const child = (yield* Effect.promise(() => first.json())) as Session.Info
        expect(child.external?.historical).toBe(true)
        const second = yield* request(`/session/${parent.id}/external-session`, { messageID, partID })
        expect(second.status).toBe(200)
        expect(((yield* Effect.promise(() => second.json())) as Session.Info).id).toBe(child.id)
        expect(yield* sessions.messages({ sessionID: child.id })).toHaveLength(2)
        const status = yield* request(`/session/${child.id}/external-control`, { action: "status" })
        expect(status.status).toBe(200)
        expect(yield* Effect.promise(() => status.json())).toMatchObject({ available: false })
        for (const [route, body] of [
          ["external-control", { action: "message", message: "must not run" }],
          ["prompt_async", { parts: [{ type: "text", text: "must not run" }] }],
          ["command", { command: "init", arguments: "" }],
          ["shell", { agent: "build", command: "echo must-not-run" }],
          ["fork", {}],
          ["revert", { messageID }],
          ["summarize", { providerID: "test", modelID: "test" }],
        ] as const) {
          const response = yield* request(`/session/${child.id}/${route}`, body)
          expect(response.status).toBe(400)
        }
        expect(yield* sessions.messages({ sessionID: child.id })).toHaveLength(2)
        yield* sessions.remove(parent.id)
      }),
    { git: true },
  )
})
