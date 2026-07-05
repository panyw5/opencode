import { describe, expect, test } from "bun:test"
import { modelProviderIconID } from "./model-provider-icon"

type IconModel = Parameters<typeof modelProviderIconID>[0]

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
