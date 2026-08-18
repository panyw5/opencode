import { describe, expect, test } from "bun:test"
import type * as ModelsDev from "@opencode-ai/core/models-dev"
import { findLimitReference } from "../../src/provider/limit-reference"

const model = (id: string, context: number, output = 32000): ModelsDev.Model =>
  ({
    id,
    name: id,
    release_date: "2026-01-01",
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    limit: { context, output },
  }) as ModelsDev.Model

const catalog = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    env: [],
    models: {
      "deepseek/deepseek-v4-flash": model("deepseek/deepseek-v4-flash", 1_048_576, 384_000),
      "deepseek/deepseek-v4-flash-0731": model("deepseek/deepseek-v4-flash-0731", 1_310_720, 393_216),
      "deepseek/deepseek-v4-pro": model("deepseek/deepseek-v4-pro", 1_048_576, 393_216),
      "openai/gpt-5-preview": model("openai/gpt-5-preview", 400_000, 128_000),
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    env: [],
    models: {
      "deepseek-v4-flash": model("deepseek-v4-flash", 1_000_000, 384_000),
      "deepseek-v4-pro": model("deepseek-v4-pro", 1_000_000, 384_000),
    },
  },
} as Record<string, ModelsDev.Provider>

describe("findLimitReference", () => {
  test("prefers dated openrouter id over undated sibling", () => {
    const hit = findLimitReference("deepseek-v4-flash-0731", catalog)
    expect(hit?.source).toBe("openrouter")
    expect(hit?.matchedID).toBe("deepseek/deepseek-v4-flash-0731")
    expect(hit?.context).toBe(1_310_720)
  })

  test("matches prefixed openrouter id exactly", () => {
    const hit = findLimitReference("deepseek/deepseek-v4-flash-0731", catalog)
    expect(hit?.matchedID).toBe("deepseek/deepseek-v4-flash-0731")
    expect(hit?.context).toBe(1_310_720)
  })

  test("does not reuse a dated sibling for an undated query", () => {
    const hit = findLimitReference("deepseek-v4-flash", catalog)
    expect(hit?.matchedID).toBe("deepseek/deepseek-v4-flash")
    expect(hit?.context).toBe(1_048_576)
  })

  test("keeps preview as a required qualifier", () => {
    const hit = findLimitReference("gpt-5-preview", catalog)
    expect(hit?.matchedID).toBe("openai/gpt-5-preview")
    expect(hit?.context).toBe(400_000)
  })

  test("does not match a different family", () => {
    const hit = findLimitReference("deepseek-v4-pro-0731", catalog)
    expect(hit?.matchedID).not.toContain("flash")
    expect(hit?.matchedID).toContain("pro")
  })

  test("returns undefined for unknown models", () => {
    expect(findLimitReference("totally-made-up-model", catalog)).toBeUndefined()
  })
})
