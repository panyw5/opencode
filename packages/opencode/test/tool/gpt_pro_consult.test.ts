import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Browser } from "../../src/browser"
import { Truncate } from "../../src/tool/truncate"
import { GptProConsultTool } from "../../src/tool/gpt_pro_consult"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import type { GptProCommand, GptProJob } from "@opencode-ai/util/gpt-pro"
import { testEffect } from "../lib/effect"

const calls: Array<{ owner: string; input: GptProCommand }> = []
const browser = Layer.mock(Browser.Service, { gptPro: (owner, input) => Effect.sync(() => {
  calls.push({ owner, input })
  return { id: "gpt_test", owner, requestID: "request", phase: "completed", prompt: input.prompt ?? "Question", url: "https://chatgpt.com/c/test", createdAt: 1, updatedAt: 2, submitted: true, revision: 1, model: "GPT-6 Pro", text: "Answer", html: "<p>Answer</p>" } satisfies GptProJob
}) })
const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Truncate.defaultLayer, browser))
function context(deny = false) {
  const asks: string[] = []
  const updates: unknown[] = []
  const ctx: Tool.Context = { sessionID: SessionID.make("ses_gptpro"), messageID: MessageID.make("msg_gptpro"), callID: "call_test", agent: "build", abort: AbortSignal.any([]), messages: [], metadata: value => Effect.sync(() => { updates.push(value) }), ask: value => Effect.sync(() => { asks.push(value.permission); if (deny) throw new Error("denied") }) }
  return { ctx, asks, updates }
}
describe("gpt_pro_consult tool", () => {
  it.instance("asks permission, uses the current session owner, and returns final HTML", () => Effect.gen(function* () {
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
  }))
  it.instance("permission denial dispatches no browser command", () => Effect.gen(function* () {
    calls.length = 0
    const c = context(true)
    const info = yield* GptProConsultTool
    const tool = yield* info.init()
    const result = yield* Effect.exit(tool.execute({ prompt: "Question" }, c.ctx))
    expect(Exit.isFailure(result)).toBe(true)
    expect(calls).toHaveLength(0)
  }))
})
