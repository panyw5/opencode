import { describe, expect, test } from "bun:test"
import {
  customProviderNpmPackages,
  isModelConfigFieldVisible,
  modelConfig,
  validateCustomProvider,
  type ModelRow,
} from "./dialog-custom-provider-form"

const t = (key: string) => key

describe("customProviderNpmPackages", () => {
  test("offers compatible specialized SDKs while retaining existing SDKs", () => {
    expect(customProviderNpmPackages()).toEqual([
      "@ai-sdk/openai-compatible",
      "@ai-sdk/openai",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
      "@ai-sdk/groq",
      "@ai-sdk/mistral",
      "@ai-sdk/alibaba",
      "@openrouter/ai-sdk-provider",
      "@ai-sdk/xai",
      "@ai-sdk/togetherai",
      "@ai-sdk/cerebras",
      "@ai-sdk/deepinfra",
    ])
    expect(customProviderNpmPackages(" @ai-sdk/google ")).toEqual(customProviderNpmPackages())
    expect(customProviderNpmPackages("custom-sdk")[0]).toBe("custom-sdk")
  })

  test("does not offer cloud authentication or distinct protocol SDKs", () => {
    for (const npm of ["@ai-sdk/azure", "@ai-sdk/google-vertex", "@ai-sdk/amazon-bedrock", "@ai-sdk/cohere"]) {
      expect(customProviderNpmPackages()).not.toContain(npm)
      expect(customProviderNpmPackages(npm)[0]).toBe(npm)
    }
  })
})

function model(input: { row: string; id: string; name: string; values?: Record<string, string> }): ModelRow {
  return {
    row: input.row,
    id: input.id,
    name: input.name,
    expanded: false,
    config: modelConfig().map((item) => ({
      ...item,
      value: input.values?.[item.key] ?? item.value,
    })),
    err: {},
  }
}

describe("validateCustomProvider", () => {
  test.each([
    "https://api.example.com",
    "https://api.example.com/",
    "https://api.example.com/v1",
    "https://api.example.com/v1/",
  ])("supplies v1 exactly once when saving %s", (baseURL) => {
    const result = validateCustomProvider({
      form: {
        providerID: "v1-provider",
        name: "V1 provider",
        baseURL,
        apiKey: "",
        models: [model({ row: "m0", id: "smoke", name: "Smoke" })],
        headers: [],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })
    expect(result.result?.config.options.baseURL).toBe("https://api.example.com/v1")
  })
  test.each([
    ["@ai-sdk/groq", { reasoningFormat: "parsed", reasoningEffort: "low" }],
    ["@ai-sdk/mistral", { safePrompt: true, parallelToolCalls: false }],
    ["@ai-sdk/alibaba", { enableThinking: true, thinkingBudget: 512 }],
    ["@openrouter/ai-sdk-provider", { provider: { order: ["test-upstream"] }, reasoning: { effort: "low" } }],
    ["@ai-sdk/xai", { reasoningEffort: "low", parallel_function_calling: false }],
    ["@ai-sdk/togetherai", { reasoningEffort: "low" }],
    ["@ai-sdk/cerebras", { reasoningEffort: "low" }],
    ["@ai-sdk/deepinfra", { reasoningEffort: "low" }],
  ])("preserves %s specialized options and variants", (npm, options) => {
    const variants = { custom: { ...options } }
    const result = validateCustomProvider({
      form: {
        providerID: "specialized-smoke",
        npm,
        name: "Specialized smoke",
        baseURL: "https://gateway.example.com/v1",
        apiKey: "test-key",
        models: [
          model({
            row: "m0",
            id: "smoke-model",
            name: "Smoke",
            values: {
              options: JSON.stringify(options),
              variants: JSON.stringify(variants),
            },
          }),
        ],
        headers: [],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })
    expect(result.result?.config.npm).toBe(npm)
    const expected = { name: "Smoke", options, variants }
    expect(result.result?.config.models["smoke-model"]).toEqual(expected)
  })
  test("preserves Google SDK, endpoint and model when saving", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-google",
        npm: "@ai-sdk/google",
        name: "Google Gateway",
        baseURL: "https://gateway.example.com/v1beta",
        apiKey: "google-test-key",
        models: [model({ row: "m0", id: "gemini-2.5-flash", name: "Gemini" })],
        headers: [],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })
    expect(result.result?.config.npm).toBe("@ai-sdk/google")
    expect(result.result?.config.options.baseURL).toBe("https://gateway.example.com/v1beta")
    expect(result.result?.config.models).toEqual({ "gemini-2.5-flash": { name: "Gemini" } })
    expect(result.result?.key).toBe("google-test-key")
  })
  test("hides uncommon detail fields without removing their form rows", () => {
    const rows = modelConfig()
    const hidden = rows.filter((row) => !isModelConfigFieldVisible(row.key)).map((row) => row.key)
    expect(hidden).toEqual(["family", "release_date", "status", "provider.npm", "provider.api"])
    expect(rows.filter((row) => isModelConfigFieldVisible(row.key))).toHaveLength(22)
    expect(isModelConfigFieldVisible("reasoning")).toBe(true)
    expect(isModelConfigFieldVisible("limit.context")).toBe(true)
    expect(isModelConfigFieldVisible("cost.input")).toBe(true)
  })

  test("saving a visible edit preserves hidden metadata and connection overrides", () => {
    const metadata = {
      family: "existing-family",
      release_date: "2026-01-01",
      status: "beta",
      provider: { npm: "@ai-sdk/openai", api: "https://example.com/v1" },
      reasoning: false,
    }
    const row = { ...model({ row: "m0", id: "model-a", name: "Model A" }), config: modelConfig(metadata) }
    const index = row.config.findIndex((item) => item.key === "reasoning")
    row.config[index].value = "true"
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "",
        models: [row],
        headers: [],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })
    const expected = { ...metadata, name: "Model A", reasoning: true }
    expect(result.result?.config.models["model-a"]).toEqual(expected)
  })

  test("builds trimmed config payload", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: " Custom Provider ",
        baseURL: "https://api.example.com ",
        apiKey: " {env: CUSTOM_PROVIDER_KEY} ",
        models: [model({ row: "m0", id: " model-a ", name: " Model A " })],
        headers: [
          { row: "h0", key: " X-Test ", value: " enabled ", err: {} },
          { row: "h1", key: "", value: "", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toEqual({
      providerID: "custom-provider",
      name: "Custom Provider",
      key: undefined,
      config: {
        npm: "@ai-sdk/openai-compatible",
        name: "Custom Provider",
        env: ["CUSTOM_PROVIDER_KEY"],
        options: {
          baseURL: "https://api.example.com/v1",
          headers: {
            "X-Test": "enabled",
          },
        },
        models: {
          "model-a": { name: "Model A" },
        },
      },
    })
  })

  test("pretty-prints existing object model config values for JSON fields", () => {
    const rows = modelConfig({
      options: { reasoningEffort: "high" },
      headers: { "X-Test": "1" },
    })
    const options = rows.find((row) => row.key === "options")
    const headers = rows.find((row) => row.key === "headers")
    expect(options?.kind).toBe("json")
    expect(options?.value).toBe('{\n  "reasoningEffort": "high"\n}')
    expect(headers?.value).toBe('{\n  "X-Test": "1"\n}')
  })

  test("parses optional model config values and omits blanks", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "",
        models: [
          model({
            row: "m0",
            id: "model-a",
            name: "Model A",
            values: {
              reasoning: "true",
              temperature: "false",
              "limit.context": "128000",
              "modalities.input": "text,image",
              options: '{"reasoningEffort":"high"}',
            },
          }),
        ],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result?.config.models as unknown).toEqual({
      "model-a": {
        name: "Model A",
        reasoning: true,
        temperature: false,
        limit: {
          context: 128000,
        },
        modalities: {
          input: ["text", "image"],
        },
        options: {
          reasoningEffort: "high",
        },
      },
    })
  })

  test("flags invalid model config values on the matching key", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "",
        models: [
          model({
            row: "m0",
            id: "model-a",
            name: "Model A",
            values: {
              reasoning: "maybe",
              options: "{bad",
            },
          }),
        ],
        headers: [{ row: "h0", key: "", value: "", err: {} }],
        err: {},
      },
      t,
      disabledProviders: [],
      existingProviderIDs: new Set(),
    })

    expect(result.result).toBeUndefined()
    expect(result.models[0].config).toEqual({
      reasoning: "provider.custom.error.boolean",
      options: "provider.custom.error.json",
    })
  })

  test("flags duplicate rows and allows reconnecting disabled providers", () => {
    const result = validateCustomProvider({
      form: {
        providerID: "custom-provider",
        name: "Provider",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: [
          model({ row: "m0", id: "model-a", name: "Model A" }),
          model({ row: "m1", id: "model-a", name: "Model A 2" }),
        ],
        headers: [
          { row: "h0", key: "Authorization", value: "one", err: {} },
          { row: "h1", key: "authorization", value: "two", err: {} },
        ],
        err: {},
      },
      t,
      disabledProviders: ["custom-provider"],
      existingProviderIDs: new Set(["custom-provider"]),
    })

    expect(result.result).toBeUndefined()
    expect(result.err.providerID).toBeUndefined()
    expect(result.models[1]).toEqual({
      id: "provider.custom.error.duplicate",
      name: undefined,
      config: {},
    })
    expect(result.headers[1]).toEqual({
      key: "provider.custom.error.duplicate",
      value: undefined,
    })
  })
})
