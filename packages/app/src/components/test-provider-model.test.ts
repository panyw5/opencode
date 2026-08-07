import { describe, expect, test } from "bun:test"
import {
  buildTestHeaders,
  chatCompletionsTestBody,
  chatCompletionsUrl,
  testProviderModel,
} from "./test-provider-model"

describe("chatCompletionsUrl", () => {
  test("appends chat/completions to base", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions",
    )
  })

  test("strips trailing slashes", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/chat/completions",
    )
  })

  test("does not double append when already complete", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1/chat/completions",
    )
  })

  test("returns empty for blank base", () => {
    expect(chatCompletionsUrl("   ")).toBe("")
  })
})

describe("chatCompletionsTestBody", () => {
  test("uses trimmed model id and max_tokens 1", () => {
    expect(chatCompletionsTestBody("  gpt-4o  ")).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    })
  })
})

describe("buildTestHeaders", () => {
  test("adds bearer auth for bare keys", () => {
    expect(buildTestHeaders({ apiKey: " sk-test " })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    })
  })

  test("skips env-ref keys that cannot be resolved in browser", () => {
    expect(buildTestHeaders({ apiKey: "{env:MY_KEY}" })).toEqual({
      "Content-Type": "application/json",
    })
  })

  test("merges custom headers", () => {
    expect(
      buildTestHeaders({
        apiKey: "k",
        headers: [
          { key: " X-Custom ", value: " yes " },
          { key: "", value: "skip" },
        ],
      }),
    ).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer k",
      "X-Custom": "yes",
    })
  })
})

describe("testProviderModel", () => {
  test("fails fast without baseURL or model id", async () => {
    const missingBase = await testProviderModel({ baseURL: "", apiKey: "k", modelId: "m" })
    expect(missingBase.ok).toBe(false)
    if (!missingBase.ok) expect(missingBase.error).toContain("baseURL")

    const missingModel = await testProviderModel({
      baseURL: "https://api.example.com/v1",
      apiKey: "k",
      modelId: "  ",
    })
    expect(missingModel.ok).toBe(false)
    if (!missingModel.ok) expect(missingModel.error).toContain("model")
  })

  test("reports success on HTTP 200", async () => {
    const result = await testProviderModel({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-4o",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://api.example.com/v1/chat/completions")
        expect(init?.method).toBe("POST")
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe("gpt-4o")
        expect(body.max_tokens).toBe(1)
        return new Response(JSON.stringify({ id: "chatcmpl-1", choices: [] }), {
          status: 200,
          statusText: "OK",
        })
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe(200)
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    }
  })

  test("reports failure with body preview on non-2xx", async () => {
    const result = await testProviderModel({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "missing-model",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "model not found" } }), {
          status: 404,
          statusText: "Not Found",
        }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(404)
      expect(result.error).toContain("404")
      expect(result.preview).toContain("model not found")
    }
  })

  test("reports network errors", async () => {
    const result = await testProviderModel({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-4o",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Failed to fetch")
  })
})
