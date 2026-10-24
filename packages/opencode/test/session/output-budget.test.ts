import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Agent } from "@/agent/agent"
import type { Plugin } from "@/plugin"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageID, SessionID } from "@/session/schema"
import { usable, isOverflow } from "@/session/overflow"
import { Token } from "@/util/token"

const model = (limit: Provider.Model["limit"]): Provider.Model => ({
  id: ModelID.make("budget-model"),
  providerID: ProviderID.make("budget-test"),
  name: "Budget test",
  api: { id: "budget-model", npm: "@ai-sdk/openai-compatible", url: "http://localhost/v1" },
  limit,
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
})

describe("generation output budget", () => {
  test.each([
    { output: 384_000, expected: 256_000 },
    { output: 128_000, expected: 128_000 },
    { output: 8_192, expected: 8_192 },
    { output: 0, expected: 32_000 },
  ])("uses the model output limit $output with the V2 ceiling/fallback", ({ output, expected }) => {
    expect(ProviderTransform.maxOutputTokens(model({ context: 1_000_000, output }))).toBe(expected)
  })

  test("keeps stricter environment ceilings without allowing them to bypass the policy", () => {
    const wide = model({ context: 1_000_000, output: 384_000 })
    expect(ProviderTransform.maxOutputTokens(wide, 64_000)).toBe(64_000)
    expect(ProviderTransform.maxOutputTokens(wide, 1_000_000)).toBe(256_000)
    expect(ProviderTransform.maxOutputTokens(model({ context: 1_000_000, output: 0 }), 128_000)).toBe(32_000)
  })

  test("caps compaction at 32K or the smaller model/environment limit", () => {
    const wide = model({ context: 1_000_000, output: 384_000 })
    expect(ProviderTransform.maxOutputTokens(wide, undefined, { kind: "compaction" })).toBe(32_000)
    expect(ProviderTransform.maxOutputTokens(wide, 8_000, { kind: "compaction" })).toBe(8_000)
    expect(
      ProviderTransform.maxOutputTokens(model({ context: 100_000, output: 4_096 }), undefined, { kind: "compaction" }),
    ).toBe(4_096)
  })

  test("fits measured input and estimated additions with the V2 15% estimate margin", () => {
    expect(
      ProviderTransform.maxOutputTokens(model({ context: 1_000_000, output: 384_000 }), undefined, {
        inputTokens: { measured: 700_000, estimated: 100_000 },
      }),
    ).toBe(185_000)
    expect(
      ProviderTransform.maxOutputTokens(model({ context: 200_000, output: 128_000 }), undefined, {
        inputTokens: { measured: 150_000, estimated: 10_000 },
      }),
    ).toBe(38_500)
  })

  test("fits summary output to remaining room too", () => {
    expect(
      ProviderTransform.maxOutputTokens(model({ context: 100_000, output: 384_000 }), undefined, {
        kind: "compaction",
        inputTokens: { measured: 80_000, estimated: 0 },
      }),
    ).toBe(20_000)
  })

  test("matches V2's minimum reply allowance without exceeding a smaller model cap", () => {
    const inputTokens = { measured: 100_000, estimated: 0 }
    expect(
      ProviderTransform.maxOutputTokens(model({ context: 100_000, output: 128_000 }), undefined, { inputTokens }),
    ).toBe(1_024)
    expect(
      ProviderTransform.maxOutputTokens(model({ context: 100_000, output: 512 }), undefined, { inputTokens }),
    ).toBe(512)
  })

  test("does not infer remaining space when the context limit is unknown", () => {
    expect(
      ProviderTransform.maxOutputTokens(model({ context: 0, output: 384_000 }), undefined, {
        inputTokens: { measured: 1_000_000, estimated: 1_000_000 },
      }),
    ).toBe(256_000)
  })

  test("does not reserve a 256K response from a smaller compaction window", () => {
    const small = model({ context: 128_000, output: 384_000 })
    expect(usable({ cfg: {}, model: small })).toBe(96_000)
    expect(
      isOverflow({
        cfg: {},
        model: small,
        tokens: { input: 1_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ).toBe(false)
    expect(usable({ cfg: {}, model: model({ context: 16_000, output: 128_000 }) })).toBe(14_400)
    expect(usable({ cfg: {}, model: small })).toBe(
      usable({ cfg: {}, model: model({ context: 128_000, output: 32_000 }) }),
    )
  })
})

const agent: Agent.Info = { name: "test", mode: "primary", options: {}, permission: [] }
const sessionID = SessionID.make("ses_budget_test")
const plugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
} as unknown as Plugin.Interface

const prepare = (input: {
  context?: number
  output?: number
  content?: string
  system?: string[]
  tools?: Parameters<typeof LLMRequestPrep.prepare>[0]["tools"]
  kind?: "primary" | "compaction"
  plugin?: Plugin.Interface
  flags?: RuntimeFlags.Info
}) => {
  const selected = model({ context: input.context ?? 1_000_000, output: input.output ?? 384_000 })
  return LLMRequestPrep.prepare({
    sessionID,
    user: {
      id: MessageID.make("msg_budget_test"),
      sessionID,
      role: "user",
      agent: "test",
      time: { created: 1 },
      model: { modelID: selected.id, providerID: selected.providerID },
    },
    model: selected,
    agent,
    system: input.system ?? [],
    messages: [{ role: "user", content: input.content ?? "Hello" }],
    tools: input.tools ?? {},
    provider: { id: selected.providerID, options: {} } as Provider.Info,
    auth: undefined,
    plugin: input.plugin ?? plugin,
    flags: input.flags ?? ({} as RuntimeFlags.Info),
    kind: input.kind,
    isWorkflow: false,
  }).pipe(Effect.runPromise)
}

describe("prepared request output budget", () => {
  test("uses 256K for primary and 32K for explicit summary requests", async () => {
    expect((await prepare({})).params.maxOutputTokens).toBe(256_000)
    expect((await prepare({ kind: "compaction" })).params.maxOutputTokens).toBe(32_000)
    expect((await prepare({ output: 0 })).params.maxOutputTokens).toBe(32_000)
  })

  test("accounts for the actual system prompt, messages and tool JSON schemas", async () => {
    const tools = {
      lookup: {
        description: "d".repeat(8_000),
        inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } } }),
      },
    }
    const prepared = await prepare({
      context: 100_000,
      content: "x".repeat(200_000),
      system: ["s".repeat(16_000)],
      tools,
    })
    const estimated =
      prepared.messages.reduce((sum, message) => sum + Token.estimate(message.content as string), 0) +
      Token.estimate(
        "lookup" +
          tools.lookup.description +
          JSON.stringify({ type: "object", properties: { query: { type: "string" } } }),
      )
    expect(prepared.params.maxOutputTokens).toBe(100_000 - Math.ceil(estimated * 1.15))
    expect(prepared.params.maxOutputTokens).toBeLessThan(
      (await prepare({ context: 100_000, content: "x".repeat(200_000) })).params.maxOutputTokens!,
    )
  })

  test("does not treat encoded media or opaque provider state as prompt text", () => {
    const large = "a".repeat(1_000_000)
    const estimate = LLMRequestPrep.estimateInputTokens({
      tools: [],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: large },
            { type: "file", mediaType: "application/pdf", data: large },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "abcd", providerOptions: { openai: { encryptedContent: large } } }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_image",
              toolName: "screenshot",
              output: { type: "content", value: [{ type: "image-data", mediaType: "image/png", data: large }] },
            },
          ],
        },
      ],
    })
    expect(estimate).toBe(5_001)
  })

  test("keeps smaller plugin budgets and protocol omissions while bounding larger budgets", async () => {
    const replace = (value: number | undefined) =>
      ({
        trigger(name: string, _input: unknown, output: unknown) {
          return Effect.sync(() => {
            if (name === "chat.params") (output as { maxOutputTokens?: number }).maxOutputTokens = value
            return output
          })
        },
      }) as unknown as Plugin.Interface
    expect((await prepare({ plugin: replace(512) })).params.maxOutputTokens).toBe(512)
    expect((await prepare({ plugin: replace(1_000_000) })).params.maxOutputTokens).toBe(256_000)
    expect((await prepare({ plugin: replace(undefined) })).params.maxOutputTokens).toBeUndefined()
    expect((await prepare({ plugin: replace(1_000_000), kind: "compaction" })).params.maxOutputTokens).toBe(32_000)
  })
})
