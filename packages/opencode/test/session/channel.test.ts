import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Config } from "@/config/config"
import { Server } from "@/server/server"
import { MessageID, PartID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const fixture = `${import.meta.dir}/../fixture/acp-agent.mjs`

const config = {
  agent_backends: {
    codex: { type: "acp", command: [process.execPath, fixture] },
    claude: { type: "acp", command: [process.execPath, fixture] },
  },
  agent_channels: { idle_timeout_ms: 60_000 },
  mcp: { "test-mcp": { type: "local", command: [process.execPath, fixture] } },
} satisfies Partial<Config.Info>

const allowAll = [{ permission: "*", pattern: "*", action: "allow" as const }]

function call(instance: { directory: string }, route: string, init?: { method?: string; body?: unknown }) {
  return Effect.promise(async () => {
    const response = await Server.Default().app.request(route, {
      method: init?.method ?? "GET",
      headers: { "x-opencode-directory": instance.directory, "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const text = await response.text()
    let body: any
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = text
    }
    return { status: response.status, body, text }
  })
}

const create = (instance: { directory: string }) =>
  call(instance, "/session", {
    method: "POST",
    body: { channel: { kind: "acp", advisor: "codex" }, permission: allowAll },
  })

const prompt = (instance: { directory: string }, sessionID: string, parts: unknown[]) =>
  call(instance, `/session/${sessionID}/message`, {
    method: "POST",
    body: { messageID: MessageID.ascending(), parts },
  })

const textPart = (text: string) => ({ id: PartID.ascending(), type: "text", text })

const textOf = (message: any) =>
  (message?.parts ?? [])
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("")

const messages = (instance: { directory: string }, sessionID: string) =>
  call(instance, `/session/${sessionID}/message`).pipe(Effect.map((result) => result.body as any[]))

describe("session-level external channel", () => {
  it.instance(
    "runs prompts through the selected ACP channel and exposes configured MCP servers",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const created = yield* create(instance)
        expect(created.status).toBe(200)
        expect(created.body.channel).toMatchObject({ kind: "acp", advisor: "codex" })
        const sessionID = created.body.id as string

        const first = yield* prompt(instance, sessionID, [textPart("hello")])
        expect(first.status).toBe(200)
        expect(first.body.info.role).toBe("assistant")
        expect(textOf(first.body)).toContain("ACP_REPLY_1: complete")
        expect(first.body.parts.some((part: any) => part.type === "tool" && part.tool === "external_tool")).toBe(true)

        const second = yield* prompt(instance, sessionID, [textPart("second")])
        expect(textOf(second.body)).toContain("ACP_REPLY_2: complete")

        const mcp = yield* prompt(instance, sessionID, [textPart("mcp")])
        expect(textOf(mcp.body)).toContain("MCP=test-mcp")
      }),
    { config },
  )

  it.instance(
    "stops a running channel turn without killing the session process",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const created = yield* create(instance)
        const sessionID = created.body.id as string

        const started = yield* call(instance, `/session/${sessionID}/prompt_async`, {
          method: "POST",
          body: { messageID: MessageID.ascending(), parts: [textPart("hang")] },
        })
        expect(started.status).toBe(204)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* messages(instance, sessionID)
            return list.some(
              (message) =>
                message.info.role === "user" &&
                message.parts?.some((part: any) => part.type === "text" && part.text === "hang"),
            )
              ? true
              : undefined
          }),
          "hang prompt was not accepted",
          10000,
        )

        const aborted = yield* call(instance, `/session/${sessionID}/abort`, { method: "POST" })
        expect(aborted.status).toBe(200)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const list = yield* messages(instance, sessionID)
            const assistant = list.find((message) => message.info.role === "assistant")
            return assistant?.info.time.completed ? true : undefined
          }),
          "aborted channel turn did not finalize",
          10000,
        )

        const after = yield* prompt(instance, sessionID, [textPart("after")])
        expect(textOf(after.body)).toContain("ACP_REPLY_2: complete")
      }),
    { config },
  )

  it.instance(
    "exposes and updates the external agent model",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const created = yield* create(instance)
        const sessionID = created.body.id as string

        const first = yield* prompt(instance, sessionID, [textPart("hello")])
        expect(first.status).toBe(200)

        const options = yield* call(instance, `/session/${sessionID}/channel`)
        expect(options.status).toBe(200)
        expect(options.body.advisor).toBe("codex")
        expect(options.body.models.map((item: any) => item.id)).toEqual(["fixture/default", "fixture/other"])
        expect(options.body.model).toBe("fixture/default")

        const updated = yield* call(instance, `/session/${sessionID}/channel`, {
          method: "PATCH",
          body: { model: "fixture/other" },
        })
        expect(updated.status).toBe(200)
        expect(updated.body).toBe(true)

        const after = yield* call(instance, `/session/${sessionID}/channel`)
        expect(after.body.model).toBe("fixture/other")

        const reply = yield* prompt(instance, sessionID, [textPart("after model switch")])
        expect(textOf(reply.body)).toContain("ACP_REPLY_2: complete")
      }),
    { config },
  )

  it.instance(
    "keeps @advisor consultations inside channel sessions",
    () =>
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const created = yield* create(instance)
        const sessionID = created.body.id as string

        const result = yield* prompt(instance, sessionID, [
          textPart("@claude review the repository"),
          {
            id: PartID.ascending(),
            type: "agent",
            name: "claude",
            source: { value: "@claude", start: 0, end: 7 },
          },
        ])
        expect(result.status).toBe(200)
        expect(textOf(result.body)).toContain("ACP_REPLY_1: complete")

        const child = yield* pollWithTimeout(
          Effect.gen(function* () {
            const listed = yield* call(instance, `/session/${sessionID}/children`)
            const list = (listed.body ?? []) as any[]
            return list.find((item) => item.external?.advisor === "claude")
          }),
          "consult child session was not created",
          15000,
        )
        expect(child.external.advisor).toBe("claude")
      }),
    { config },
  )
})
