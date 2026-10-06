import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Browser } from "../../src/browser"
import { Truncate } from "../../src/tool/truncate"
import { GptProConsultTool } from "../../src/tool/gpt_pro_consult"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import type { GptProCommand, GptProJob, GptProPhase } from "@opencode-ai/util/gpt-pro"
import { testEffect } from "../lib/effect"

const calls: Array<{ owner: string; input: GptProCommand }> = []
let phase: GptProPhase = "completed"
let recovery = false
const browser = Layer.mock(Browser.Service, {
  gptPro: (owner, input) =>
    Effect.sync(() => {
      calls.push({ owner, input })
      return {
        id: "gpt_test",
        owner,
        requestID: "request",
        phase,
        ...(recovery
          ? { recovery: { stage: "model" as const, reason: "Unknown picker" }, sendAttempted: false, submitted: false }
          : {}),
        background: input.background ?? input.action === "background",
        prompt: input.prompt ?? "Question",
        url: "https://chatgpt.com/c/test",
        createdAt: 1,
        updatedAt: 2,
        submitted: !recovery,
        revision: 1,
        model: "GPT-6 Pro",
        text: "Answer",
        html: "<p>Answer</p>",
      } satisfies GptProJob
    }),
})
const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Truncate.defaultLayer, browser))
function context(deny = false) {
  const asks: string[] = []
  const updates: unknown[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_gptpro"),
    messageID: MessageID.make("msg_gptpro"),
    callID: "call_test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: (value) =>
      Effect.sync(() => {
        updates.push(value)
      }),
    ask: (value) =>
      Effect.sync(() => {
        asks.push(value.permission)
        if (deny) throw new Error("denied")
      }),
  }
  return { ctx, asks, updates }
}
describe("gpt_pro_consult tool", () => {
  it.instance(
    "foreground fixed-flow failure returns control to the model immediately with scoped browser guidance",
    () =>
      Effect.gen(function* () {
        phase = "paused"
        recovery = true
        calls.length = 0
        try {
          const tool = yield* (yield* GptProConsultTool).init()
          const result = yield* tool.execute({ prompt: "Original prompt", background: false }, context().ctx)
          const output = JSON.parse(result.output)
          expect(calls).toHaveLength(1)
          expect(output.recovery.stage).toBe("model")
          expect(output.managed_prompt).toBe("Original prompt")
          expect(output.send_attempted).toBe(false)
          expect(output.instruction).toContain("browser_* tools with consultation_id=gpt_test")
          expect(output.instruction).toContain("resume this same ID")
        } finally {
          phase = "completed"
          recovery = false
        }
      }),
  )
  it.instance("a failed background consultation never claims it is still running", () =>
    Effect.gen(function* () {
      calls.length = 0
      phase = "failed"
      try {
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* tool.execute(
          { action: "status", consultation_id: "gpt_test", background: true },
          context().ctx,
        )
        expect(JSON.parse(result.output).instruction).toContain("did not complete")
        expect(JSON.parse(result.output).instruction).not.toContain("running independently")
        expect(calls).toHaveLength(1)
      } finally {
        phase = "completed"
      }
    }),
  )
  it.instance("background returns while Pro is generating without any wait or poll", () =>
    Effect.gen(function* () {
      calls.length = 0
      phase = "generating"
      try {
        const c = context()
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* tool.execute({ prompt: "Long question", background: true }, c.ctx)
        expect(calls).toHaveLength(1)
        expect(calls[0].input.background).toBe(true)
        expect(JSON.parse(result.output)).toMatchObject({ background: true, phase: "generating" })
        expect(result.metadata.background).toBe(true)
        expect(JSON.parse(result.output).instruction).toContain("automatically")
      } finally {
        phase = "completed"
      }
    }),
  )
  it.instance("promotion preserves consultation ID and sends no prompt", () =>
    Effect.gen(function* () {
      calls.length = 0
      phase = "generating"
      try {
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* tool.execute({ action: "background", consultation_id: "gpt_test" }, context().ctx)
        expect(calls).toHaveLength(1)
        expect(calls[0].input).toMatchObject({ action: "background", id: "gpt_test", prompt: undefined })
        expect(result.metadata.background).toBe(true)
      } finally {
        phase = "completed"
      }
    }),
  )
  it.instance("asks permission, uses the current session owner, and returns final HTML", () =>
    Effect.gen(function* () {
      calls.length = 0
      const c = context()
      const info = yield* GptProConsultTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ prompt: "Question", wait_ms: 0 }, c.ctx)
      expect(c.asks).toEqual(["gpt_pro_consult"])
      expect(calls[0].owner.endsWith("\nses_gptpro")).toBe(true)
      expect(calls[0].input.requestID).toBe("ses_gptpro:call_test")
      expect(calls.at(-1)?.input.action).toBe("read")
      expect(JSON.parse(result.output).html).toBe("<p>Answer</p>")
      expect(result.metadata.consultation_id).toBe("gpt_test")
    }),
  )
  it.instance("permission denial dispatches no browser command", () =>
    Effect.gen(function* () {
      calls.length = 0
      const c = context(true)
      const info = yield* GptProConsultTool
      const tool = yield* info.init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Question" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(calls).toHaveLength(0)
    }),
  )
})
