import { describe, expect, test } from "bun:test"
import { modelProviderIconID, providerGroupIconID } from "./model-provider-icon"

type IconModel = Parameters<typeof modelProviderIconID>[0]

describe("providerGroupIconID", () => {
  test("preserves native provider icons even when models use another API", () => {
    expect(
      providerGroupIconID([{ id: "claude", provider: { id: "github-copilot" }, api: { npm: "@ai-sdk/anthropic" } }]),
    ).toBe("github-copilot")
  })

  test("uses a custom gateway API type rather than its model family", () => {
    expect(
      providerGroupIconID([
        { id: "claude", provider: { id: "gateway" }, api: { npm: "@ai-sdk/openai-compatible" } },
        { id: "gemini", provider: { id: "gateway" }, api: { npm: "@ai-sdk/openai-compatible" } },
      ]),
    ).toBe("openai")
    expect(providerGroupIconID([{ id: "gpt", provider: { id: "gateway" }, api: { npm: "@ai-sdk/anthropic" } }])).toBe(
      "anthropic",
    )
  })

  test("uses a neutral icon for mixed, unknown or missing API types", () => {
    expect(
      providerGroupIconID([
        { id: "a", provider: { id: "gateway" }, api: { npm: "@ai-sdk/openai" } },
        { id: "b", provider: { id: "gateway" }, api: { npm: "@ai-sdk/anthropic" } },
      ]),
    ).toBe("synthetic")
    expect(providerGroupIconID([{ id: "a", provider: { id: "gateway" } }])).toBe("synthetic")
    expect(providerGroupIconID([{ id: "a", provider: { id: "gateway" }, api: { npm: "custom" } }])).toBe("synthetic")
    expect(providerGroupIconID([])).toBe("synthetic")
  })
})

describe("modelProviderIconID", () => {
  test("falls back to provider id when external agent model omits api metadata", () => {
    const model = {
      id: "llm_0",
      name: "Generic LLM",
      provider: { id: "genericagent", name: "GenericAgent" },
    } satisfies IconModel

    expect(() => modelProviderIconID(model)).not.toThrow()
    expect(modelProviderIconID(model)).toBe("genericagent")
  })

  test("infers provider icon from api id", () => {
    const model = {
      id: "sonnet",
      api: { id: "claude-3-5-sonnet" },
      provider: { id: "custom", name: "Custom" },
    } satisfies IconModel

    expect(modelProviderIconID(model)).toBe("anthropic")
  })

  test("infers provider icon from sdk package when api id has no provider hint", () => {
    const model = {
      id: "chat",
      api: { id: "chat", npm: "@ai-sdk/openai" },
      provider: { id: "custom", name: "Custom" },
    } satisfies IconModel

    expect(modelProviderIconID(model)).toBe("openai")
  })
})
