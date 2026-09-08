import { describe, expect, test } from "bun:test"
import type { Model, Provider } from "@opencode-ai/core/models-dev"
import { findModelPresets } from "./model-presets"

const model: Model = {
  id: "model-a",
  name: "Model A",
  family: "a",
  release_date: "2026-01-01",
  reasoning: false,
  attachment: true,
  temperature: false,
  tool_call: true,
  cost: { input: 0, output: 2 },
  limit: { context: 128000, output: 8000 },
  modalities: { input: ["text", "image"], output: ["text"] },
  interleaved: { field: "reasoning_content" },
}
const provider = (id: string, value: Model = model): Provider => ({
  id,
  name: id,
  env: [],
  models: { [value.id]: value },
})

describe("model presets", () => {
  test("missing metadata remains unavailable instead of becoming false or zero", () => {
    const result = findModelPresets(
      { sparse: { models: { sparse: { id: "sparse", family: "sparse" } } } },
      "sparse",
      "sparse",
    )!
    expect(result.values.family).toBe("sparse")
    expect(result.values.temperature).toBeUndefined()
    expect(result.values["cost.input"]).toBeUndefined()
  })
  test("matches provider and model exactly, retaining false and zero", () => {
    const result = findModelPresets({ official: provider("official") }, " official ", " model-a ")!
    expect(result.source).toBe("official/model-a")
    expect(result.values.reasoning).toBe("false")
    expect(result.values["cost.input"]).toBe("0")
    expect(result.values["limit.context"]).toBe("128000")
    expect(JSON.parse(result.values["modalities.input"])).toEqual(["text", "image"])
    expect(JSON.parse(result.values.interleaved)).toEqual({ field: "reasoning_content" })
    expect(result.values["cost.cache_read"]).toBeUndefined()
  })

  test("does not guess unknown, partial, date-suffixed or empty model IDs", () => {
    const catalog = { official: provider("official") }
    for (const id of ["", " ", "model", "model-a-20260101", "unknown", "constructor", "__proto__"]) {
      expect(findModelPresets(catalog, "official", id)).toBeUndefined()
    }
    expect(findModelPresets(catalog, "constructor", "unknown")).toBeUndefined()
  })

  test("prefers the exact provider over conflicting entries", () => {
    const catalog = { other: provider("other", { ...model, family: "other" }), official: provider("official") }
    expect(findModelPresets(catalog, "official", model.id)?.values.family).toBe("a")
  })

  test("custom providers get reference values even when resellers disagree or omit fields", () => {
    const sol = { ...model, id: "gpt-5.6-sol", limit: { context: 1050000, input: 922000, output: 128000 } }
    const catalog = {
      reseller: provider("reseller", { ...sol, limit: { context: 372000, output: 128000 } }),
      openai: provider("openai", sol),
    }
    for (const id of ["aether", "axonhub", "reseller"]) {
      const result = findModelPresets(catalog, id, sol.id)!
      expect(result.source).toBe("openai/gpt-5.6-sol")
      expect(result.values["limit.context"]).toBe("1050000")
      expect(result.values["limit.input"]).toBe("922000")
      expect(result.values["limit.output"]).toBe("128000")
      expect(result.values["cost.input"]).toBe("0")
    }
    expect(findModelPresets(Object.fromEntries(Object.entries(catalog).reverse()), "aether", sol.id)).toEqual(
      findModelPresets(catalog, "axonhub", sol.id),
    )
  })

  test("matches namespaced IDs and case without confusing model versions or suffixes", () => {
    const sol = { ...model, id: "gpt-5.6-sol" }
    const catalog = { openai: provider("openai", sol) }
    expect(findModelPresets(catalog, "axonhub", " OpenAI/GPT-5.6-SOL ")?.source).toBe("openai/gpt-5.6-sol")
    for (const id of ["gpt-5.6", "gpt-5.6-sol-latest", "gpt-5.5-sol"]) {
      expect(findModelPresets(catalog, "aether", id)).toBeUndefined()
    }
    expect(findModelPresets(catalog, "aether", "gpt-5.6-luna")?.approximate).toBe(true)
    expect(
      findModelPresets({ router: provider("router", { ...sol, id: "openai/gpt-5.6-sol" }) }, "aether", sol.id)?.source,
    ).toBe("router/openai/gpt-5.6-sol")
  })

  test("uses a same-family reference for an unknown alias", () => {
    const sol = { ...model, id: "gpt-5.6-sol", limit: { context: 1050000, input: 922000, output: 128000 } }
    const result = findModelPresets({ openai: provider("openai", sol) }, "axonhub", "gpt-5.6-astra")!
    expect(result.approximate).toBe(true)
    expect(result.source).toBe("openai/gpt-5.6-sol")
    expect(result.values["limit.context"]).toBe("1050000")
    expect(result.values["limit.input"]).toBe("922000")
    expect(result.values["limit.output"]).toBe("128000")
  })

  test("does not use an unrelated model as a family fallback", () => {
    expect(findModelPresets({ openai: provider("openai") }, "axonhub", "claude-3-opus")).toBeUndefined()
  })

  test("uses a stable populated reference when the original vendor is unavailable", () => {
    const catalog = {
      sparse: { models: { "model-a": { id: "model-a" } } },
      beta: provider("beta"),
      alpha: provider("alpha"),
    }
    expect(findModelPresets(catalog, "aether", model.id)?.source).toBe("alpha/model-a")
    expect(findModelPresets(Object.fromEntries(Object.entries(catalog).reverse()), "axonhub", model.id)?.source).toBe(
      "alpha/model-a",
    )
  })

  test("supports explicit provider/model IDs without fuzzy matching", () => {
    const result = findModelPresets({ official: provider("official") }, "custom", "official/model-a")!
    expect(result.source).toBe("official/model-a")
    expect(result.values.family).toBe("a")
  })

  test("does not copy connection settings or incompatible experimental data", () => {
    const catalog = {
      official: provider("official", {
        ...model,
        provider: { npm: "unsafe", api: "https://example.com" },
        experimental: { modes: {} },
      }),
    }
    const result = findModelPresets(catalog, "official", model.id)!
    for (const field of ["provider.api", "provider.npm", "options", "headers", "variants", "experimental"]) {
      expect(result.values[field]).toBeUndefined()
    }
  })
})
