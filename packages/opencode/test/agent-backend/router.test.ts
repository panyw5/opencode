import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "../../src/config/config"
import { routeAgentBackend } from "../../src/agent-backend/router"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import type { Advisor } from "../../src/session/external-schema"
import { testEffect } from "../lib/effect"
import {
  advisorInterventionSnapshot,
  startAdvisorIntervention,
  sendAdvisorIntervention,
  finishAdvisorIntervention,
} from "../../src/tool/advisor-intervention"

const it = testEffect(Layer.empty)
const parameters = Schema.Struct({ prompt: Schema.String })
const context = (): Tool.Context => ({
  sessionID: SessionID.make("ses_backend"),
  messageID: MessageID.make("msg_backend"),
  agent: "build",
  messages: [],
  abort: AbortSignal.timeout(10000),
  metadata: () => Effect.void,
  ask: () => Effect.void,
})
const definition = (
  advisor: Advisor,
  execute: Tool.Def<typeof parameters>["execute"],
): Tool.Def<typeof parameters> => ({
  id: `${advisor}_consult`,
  description: "Fixture",
  parameters,
  execute,
})
const config = (value: Config.Info) => ({ get: () => Effect.succeed(value) })

describe("unified AgentBackend routing", () => {
  it.live("validates inputs before entering any backend", () =>
    Effect.gen(function* () {
      let called = false
      const tool = routeAgentBackend(
        "claude",
        definition("claude", () => {
          called = true
          return Effect.succeed({ title: "", output: "", metadata: {} })
        }),
        config({ agent_backends: { claude: { type: "acp", command: ["must-not-start"] } } }),
      )
      const result = yield* tool.execute({ prompt: 123 } as unknown as { prompt: string }, context()).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(called).toBe(false)
    }),
  )
  it.instance("ACP startup failure never falls back to a second execution", () =>
    Effect.gen(function* () {
      let called = false
      const tool = routeAgentBackend(
        "claude",
        definition("claude", () => {
          called = true
          return Effect.succeed({ title: "", output: "", metadata: {} })
        }),
        config({ agent_backends: { claude: { type: "acp", command: ["/nonexistent/acp-fixture"] } } }),
      )
      const result = yield* tool.execute({ prompt: "test" }, context()).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      expect(called).toBe(false)
    }),
  )
  test("configuration validates ACP and preserves old configurations", () => {
    const decode = Schema.decodeUnknownSync(Config.Info)
    const value = {
      external_agents: { claude: { binaryPath: "/claude" } },
      agent_backends: {
        claude: { type: "acp", command: ["adapter", "--acp"], permission: "ask" },
        pi: { type: "native-rpc" },
      },
    }
    expect(decode(value)).toMatchObject(value)
    for (const backend of [{ type: "bad" }, { type: "acp", command: [] }, { type: "acp", command: [""] }])
      expect(() => decode({ agent_backends: { claude: backend } })).toThrow()
  })

  for (const advisor of ["codex", "claude", "grok", "dsh", "pi"] as const) {
    it.live(`keeps ${advisor}'s default backend and propagates normalized metadata`, () =>
      Effect.gen(function* () {
        const kind = advisor === "pi" ? "native-rpc" : "cli-json"
        let received: unknown
        const tool = routeAgentBackend(
          advisor,
          definition(advisor, (input, ctx) =>
            Effect.gen(function* () {
              received = input
              yield* ctx.metadata({ metadata: { preview: "stream" } })
              return { title: "answer", output: "reply", metadata: { session_id: "legacy" } }
            }),
          ),
          config({}),
        )
        let metadata: unknown
        const result = yield* tool.execute(
          { prompt: "question" },
          {
            ...context(),
            metadata: (value) =>
              Effect.sync(() => {
                metadata = value
              }),
          },
        )
        expect(received).toEqual({ prompt: "question" })
        expect(metadata).toEqual({ metadata: { preview: "stream", backend: kind } })
        expect(result).toMatchObject({ output: "reply", metadata: { backend: kind, session_id: "legacy" } })
      }),
    )
  }

  it.live("rejects incompatible transports and disabled integrations before execution", () =>
    Effect.gen(function* () {
      let called = false
      const legacy = definition("claude", () => {
        called = true
        return Effect.succeed({ title: "", output: "", metadata: {} })
      })
      for (const value of [
        { agent_backends: { claude: { type: "native-rpc" as const } } },
        { external_agents: { claude: { enabled: false } } },
      ]) {
        const exit = yield* routeAgentBackend("claude", legacy, config(value))
          .execute({ prompt: "hello" }, context())
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }
      expect(called).toBe(false)
    }),
  )

  it.instance("ACP uses the same intervention path, streams events and never invokes the legacy backend", () =>
    Effect.gen(function* () {
      let legacyCalls = 0
      const tool = routeAgentBackend(
        "claude",
        definition("claude", () => {
          legacyCalls++
          return Effect.succeed({ title: "", output: "", metadata: {} })
        }),
        config({
          agent_backends: {
            claude: {
              type: "acp",
              command: [process.execPath, `${import.meta.dir}/../fixture/acp-agent.mjs`],
            },
          },
        }),
      )
      const ctx = { ...context(), callID: "call_acp" }
      const target = { sessionID: ctx.sessionID, callID: ctx.callID }
      let activated = false
      let turns = 0
      const events: string[] = []
      ctx.extra = { externalTranscript: (item: { text?: string }) => events.push(item.text ?? "") }
      ctx.metadata = (value) =>
        Effect.sync(() => {
          if (!advisorInterventionSnapshot(target)) return
          if (!activated) {
            activated = true
            startAdvisorIntervention(target)
          }
          if (!value.metadata?.intervention?.waitingForInput) return
          queueMicrotask(() => {
            if (turns++ === 0) sendAdvisorIntervention({ ...target, message: "follow-up" })
            else finishAdvisorIntervention(target)
          })
        })
      const result = yield* tool.execute({ prompt: "initial" }, ctx)
      expect(result.output).toBe("ACP_REPLY_2: complete")
      expect(result.metadata.backend).toBe("acp")
      expect(events).toContain("follow-up")
      expect(events).toContain("fixture contents")
      expect(legacyCalls).toBe(0)
      expect(advisorInterventionSnapshot(target)).toBeUndefined()
    }),
  )

  for (const policy of ["deny", "ask"] as const) {
    it.instance(`ACP ${policy} permission policy crosses the OpenCode authorization boundary`, () =>
      Effect.gen(function* () {
        const tool = routeAgentBackend(
          "claude",
          definition("claude", () => {
            throw new Error("legacy must not execute")
          }),
          config({
            agent_backends: {
              claude: {
                type: "acp",
                command: [process.execPath, `${import.meta.dir}/../fixture/acp-agent.mjs`],
                permission: policy,
                env: { ACP_FIXTURE_EMPTY_LOCATIONS: "1" },
              },
            },
          }),
        )
        const requests: string[] = []
        const result = yield* tool.execute(
          { prompt: "permission" },
          {
            ...context(),
            ask: (request) =>
              Effect.sync(() => {
                requests.push(request.permission)
                if (request.permission === "external_agent_tool") expect(request.patterns).toEqual(["read-1"])
              }),
          },
        )
        expect(result.output).toBe(policy === "ask" ? "PERMISSION_allow" : "PERMISSION_reject")
        expect(requests).toEqual(policy === "ask" ? ["claude_consult", "external_agent_tool"] : ["claude_consult"])
      }),
    )
  }
})
