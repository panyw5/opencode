import { describe, expect, test } from "bun:test"
import { applyOpenRouterUpstream, parseModels } from "../../src/provider/openrouter-upstream"

describe("applyOpenRouterUpstream", () => {
  const windows = { "deepseek/deepseek-v4-flash-0731": 1_048_576 }

  test("returns undefined for undefined input", () => {
    expect(applyOpenRouterUpstream(undefined, windows)).toBeUndefined()
  })

  test("caps context to the upstream window when smaller", () => {
    const hit = applyOpenRouterUpstream(
      {
        context: 1_310_720,
        output: 393_216,
        source: "openrouter",
        matchedID: "deepseek/deepseek-v4-flash-0731",
      },
      windows,
    )
    expect(hit?.context).toBe(1_048_576)
    expect(hit?.source).toBe("openrouter")
  })

  test("keeps the advertised context when upstream is larger", () => {
    const hit = applyOpenRouterUpstream(
      {
        context: 400_000,
        output: 128_000,
        source: "openrouter",
        matchedID: "openai/gpt-5",
      },
      { "openai/gpt-5": 500_000 },
    )
    expect(hit?.context).toBe(400_000)
  })

  test("keeps the advertised context when no window exists", () => {
    const hit = applyOpenRouterUpstream(
      {
        context: 1_310_720,
        output: 393_216,
        source: "openrouter",
        matchedID: "deepseek/deepseek-v4-flash-0731",
      },
      {},
    )
    expect(hit?.context).toBe(1_310_720)
  })
})

describe("parseModels", () => {
  test("takes the smaller of advertised and top_provider context", () => {
    const models = parseModels({
      data: [
        {
          id: "deepseek/deepseek-v4-flash-0731",
          context_length: 1_310_720,
          top_provider: { context_length: 1_048_576 },
        },
        {
          id: "deepseek/deepseek-v4-flash",
          context_length: 1_048_576,
          top_provider: { context_length: 1_024_000 },
        },
        {
          id: "x/no-window",
          context_length: 400_000,
        },
      ],
    })
    expect(models["deepseek/deepseek-v4-flash-0731"]).toBe(1_048_576)
    expect(models["deepseek/deepseek-v4-flash"]).toBe(1_024_000)
    expect(models["x/no-window"]).toBe(400_000)
  })
})
