import { describe, expect, test } from "bun:test"
import {
  anthropicMessagesTestBody,
  anthropicMessagesUrl,
  buildTestHeaders,
  chatCompletionsTestBody,
  chatCompletionsUrl,
  resolveTestProtocol,
  testEndpointUrl,
  testProviderModel,
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
})

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

describe("anthropicMessagesUrl", () => {
  test("appends messages to base", () => {
    expect(anthropicMessagesUrl("https://api.anthropic.com/v1")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
    expect(anthropicMessagesUrl("https://gateway.example.com/anthropic/v1")).toBe(
      "https://gateway.example.com/anthropic/v1/messages",
    )
  })

  test("strips trailing slashes", () => {
    expect(anthropicMessagesUrl("https://api.anthropic.com/v1/")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  test("does not double append when already complete", () => {
    expect(anthropicMessagesUrl("https://api.anthropic.com/v1/messages")).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  test("rewrites mistaken chat/completions suffix", () => {
    expect(anthropicMessagesUrl("https://gateway.example.com/anthropic/v1/chat/completions")).toBe(
      "https://gateway.example.com/anthropic/v1/messages",
    )
  })
})

describe("testEndpointUrl", () => {
  test("routes by protocol", () => {
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
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          )
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
