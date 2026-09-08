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

  test("custom providers borrow only unambiguous metadata, not pricing", () => {
    const catalog = {
      official: provider("official"),
      other: provider("other", { ...model, limit: { context: 64000, output: 8000 } }),
    }
    const result = findModelPresets(catalog, "custom", model.id)!
    expect(result.values.family).toBe("a")
    expect(result.values["limit.context"]).toBeUndefined()
    expect(result.values["limit.output"]).toBe("8000")
    expect(result.values["cost.input"]).toBeUndefined()
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
