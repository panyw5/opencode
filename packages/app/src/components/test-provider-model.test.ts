import { describe, expect, test } from "bun:test"
import {
  anthropicMessagesTestBody,
  anthropicMessagesUrl,
  buildTestHeaders,
  chatCompletionsTestBody,
  chatCompletionsUrl,
  googleGenerateContentUrl,
  providerModelsUrl,
  resolveTestProtocol,
  testEndpointUrl,
  testProviderModel,
  testRequestBody,
} from "./test-provider-model"

describe("resolveTestProtocol", () => {
  test("defaults to openai-chat", () => {
    expect(resolveTestProtocol()).toBe("openai-chat")
    expect(resolveTestProtocol("@ai-sdk/openai-compatible")).toBe("openai-chat")
    expect(resolveTestProtocol("@ai-sdk/openai")).toBe("openai-chat")
  })

  test("selects anthropic-messages for anthropic npm", () => {
    expect(resolveTestProtocol("@ai-sdk/anthropic")).toBe("anthropic-messages")
    expect(resolveTestProtocol("@ai-sdk/google-vertex/anthropic")).toBe("anthropic-messages")
  })

  test("selects Google generateContent for Google npm", () => {
    expect(resolveTestProtocol(" @AI-SDK/GOOGLE ")).toBe("google-generate-content")
  })
})

describe("googleGenerateContentUrl", () => {
  test("uses the model in the URL and preserves SDK model paths", () => {
    expect(googleGenerateContentUrl(" https://gateway.example.com/v1beta/ ", " gemini-2.5-flash ")).toBe(
      "https://gateway.example.com/v1beta/models/gemini-2.5-flash:generateContent",
    )
    expect(googleGenerateContentUrl("https://gateway.example.com/v1beta", "models/gemini-2.5-flash")).toBe(
      "https://gateway.example.com/v1beta/models/gemini-2.5-flash:generateContent",
    )
    expect(googleGenerateContentUrl("https://gateway.example.com/v1beta", "tunedModels/custom")).toBe(
      "https://gateway.example.com/v1beta/tunedModels/custom:generateContent",
    )
    expect(googleGenerateContentUrl("", "gemini")).toBe("")
    expect(googleGenerateContentUrl("https://gateway.example.com/v1beta", " ")).toBe("")
  })

  test("encodes model path segments without treating them as URL parameters", () => {
    expect(googleGenerateContentUrl("https://gateway.example.com/v1beta", "gemini?key=test#fragment")).toBe(
      "https://gateway.example.com/v1beta/models/gemini%3Fkey%3Dtest%23fragment:generateContent",
    )
  })
})

describe("chatCompletionsUrl", () => {
  test("appends chat/completions to base", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions")
  })

  test("strips trailing slashes", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1/chat/completions")
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

describe("anthropicMessagesUrl", () => {
  test("appends messages to base", () => {
    expect(anthropicMessagesUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/messages")
    expect(anthropicMessagesUrl("https://gateway.example.com/anthropic/v1")).toBe(
      "https://gateway.example.com/anthropic/v1/messages",
    )
  })

  test("strips trailing slashes", () => {
    expect(anthropicMessagesUrl("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com/v1/messages")
  })

  test("does not double append when already complete", () => {
    expect(anthropicMessagesUrl("https://api.anthropic.com/v1/messages")).toBe("https://api.anthropic.com/v1/messages")
  })

  test("rewrites mistaken chat/completions suffix", () => {
    expect(anthropicMessagesUrl("https://gateway.example.com/anthropic/v1/chat/completions")).toBe(
      "https://gateway.example.com/anthropic/v1/messages",
    )
  })
})

describe("testEndpointUrl", () => {
  test("routes by protocol", () => {
    expect(testEndpointUrl("https://gateway.example.com/v1beta", "google-generate-content", "gemini")).toBe(
      "https://gateway.example.com/v1beta/models/gemini:generateContent",
    )
    expect(testEndpointUrl("https://api.example.com/v1", "openai-chat")).toBe(
      "https://api.example.com/v1/chat/completions",
    )
    expect(testEndpointUrl("https://api.example.com/anthropic/v1", "anthropic-messages")).toBe(
      "https://api.example.com/anthropic/v1/messages",
    )
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

describe("anthropicMessagesTestBody", () => {
  test("uses trimmed model id and max_tokens 1 without stream", () => {
    expect(anthropicMessagesTestBody("  claude-sonnet-4  ")).toEqual({
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    })
  })
})

describe("buildTestHeaders", () => {
  test("uses Google API key authentication and allows custom headers", () => {
    expect(buildTestHeaders({ apiKey: " google-key ", protocol: "google-generate-content" })).toEqual({
      "Content-Type": "application/json",
      "x-goog-api-key": "google-key",
    })
    expect(buildTestHeaders({ apiKey: "{env:GOOGLE_KEY}", protocol: "google-generate-content" })).toEqual({
      "Content-Type": "application/json",
    })
    expect(
      buildTestHeaders({
        apiKey: "",
        protocol: "google-generate-content",
        headers: [{ key: "x-goog-api-key", value: "custom" }],
      }),
    ).toEqual({
      "Content-Type": "application/json",
      "x-goog-api-key": "custom",
    })
  })
  test("adds bearer auth for bare keys (openai)", () => {
    expect(buildTestHeaders({ apiKey: " sk-test " })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
    })
  })

  test("uses x-api-key and anthropic-version for anthropic", () => {
    expect(buildTestHeaders({ apiKey: " sk-ant ", protocol: "anthropic-messages" })).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "sk-ant",
      "anthropic-version": "2023-06-01",
    })
  })

  test("skips env-ref keys that cannot be resolved in browser", () => {
    expect(buildTestHeaders({ apiKey: "{env:MY_KEY}" })).toEqual({
      "Content-Type": "application/json",
    })
  })

  test("still sets anthropic-version when key is env-ref", () => {
    expect(buildTestHeaders({ apiKey: "{env:MY_KEY}", protocol: "anthropic-messages" })).toEqual({
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
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
  test.each([
    ["@ai-sdk/groq", "/chat/completions"],
    ["@ai-sdk/mistral", "/chat/completions"],
    ["@ai-sdk/alibaba", "/chat/completions"],
    ["@openrouter/ai-sdk-provider", "/chat/completions"],
    ["@ai-sdk/xai", "/chat/completions"],
    ["@ai-sdk/togetherai", "/chat/completions"],
    ["@ai-sdk/cerebras", "/chat/completions"],
    ["@ai-sdk/deepinfra", "/openai/chat/completions"],
  ])("probes %s using its SDK URL and bearer authentication", async (npm, suffix) => {
    const base = "https://gateway.example.com/v1"
    expect(resolveTestProtocol(npm)).toBe("openai-chat")
    expect(testEndpointUrl(base, resolveTestProtocol(npm), "smoke", npm)).toBe(base + suffix)
    expect(providerModelsUrl(` ${base}/ `, npm)).toBe(base + suffix.replace("/chat/completions", "/models"))
    const result = await testProviderModel({
      baseURL: base,
      apiKey: "test-key",
      npm,
      modelId: "smoke",
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(base + suffix)
        expect(init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-key" })
        expect(JSON.parse(String(init?.body))).toEqual(chatCompletionsTestBody("smoke"))
        return Response.json({ choices: [{ message: { content: "pong" } }] })
      },
    })
    expect(result.ok).toBe(true)
  })

  test("keeps DeepInfra URL construction identical to its SDK", () => {
    expect(providerModelsUrl("", "@ai-sdk/deepinfra")).toBe("")
    expect(providerModelsUrl("https://gateway.example.com/v1/openai", "@ai-sdk/deepinfra")).toBe(
      "https://gateway.example.com/v1/openai/openai/models",
    )
    expect(providerModelsUrl("https://gateway.example.com/v1/openai", "@ai-sdk/openai-compatible")).toBe(
      "https://gateway.example.com/v1/openai/models",
    )
  })
  test("sends Google contents and receives the generated response", async () => {
    const body = { contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 1 } }
    expect(testRequestBody("gemini", "google-generate-content")).toEqual(body)
    const result = await testProviderModel({
      baseURL: "https://gateway.example.com/v1beta",
      apiKey: "google-test-key",
      modelId: "gemini-2.5-flash",
      npm: "@ai-sdk/google",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://gateway.example.com/v1beta/models/gemini-2.5-flash:generateContent")
        expect(init?.method).toBe("POST")
        expect(init?.headers).toEqual({ "Content-Type": "application/json", "x-goog-api-key": "google-test-key" })
        expect(JSON.parse(String(init?.body))).toEqual(body)
        return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "pong" }] } }] })
      },
    })
    expect(result.ok).toBe(true)
    expect(result.preview).toContain("pong")
  })

  test("Google validates a missing model before fetching", async () => {
    const result = await testProviderModel({
      baseURL: "https://gateway.example.com/v1beta",
      apiKey: "",
      modelId: "",
      npm: "@ai-sdk/google",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("missing model id")
  })
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

  test("reports success on HTTP 200 (openai)", async () => {
    const result = await testProviderModel({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-4o",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://api.example.com/v1/chat/completions")
        expect(init?.method).toBe("POST")
        const headers = init?.headers as Record<string, string>
        expect(headers.Authorization).toBe("Bearer sk-test")
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

  test("uses /messages and x-api-key for anthropic npm", async () => {
    const result = await testProviderModel({
      baseURL: "https://gateway.example.com/anthropic/v1",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4",
      npm: "@ai-sdk/anthropic",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://gateway.example.com/anthropic/v1/messages")
        expect(init?.method).toBe("POST")
        const headers = init?.headers as Record<string, string>
        expect(headers["x-api-key"]).toBe("sk-ant-test")
        expect(headers["anthropic-version"]).toBe("2023-06-01")
        expect(headers.Authorization).toBeUndefined()
        const body = JSON.parse(String(init?.body))
        expect(body).toEqual({
          model: "claude-sonnet-4",
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        })
        return new Response(JSON.stringify({ id: "msg_1", type: "message", content: [] }), {
          status: 200,
          statusText: "OK",
        })
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.url).toBe("https://gateway.example.com/anthropic/v1/messages")
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

  test("marks cancelled when external signal aborts", async () => {
    const controller = new AbortController()
    const resultPromise = testProviderModel({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "gpt-4o",
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) {
            reject(new Error("missing signal"))
            return
          }
          if (signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"))
            return
          }
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
        })
      },
    })
    controller.abort()
    const result = await resultPromise
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.cancelled).toBe(true)
      expect(result.error).toBe("cancelled")
    }
  })
})
