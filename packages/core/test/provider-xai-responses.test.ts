import { createXai } from "@ai-sdk/xai"
import { describe, expect, test } from "bun:test"

function capture(response: Record<string, unknown>) {
  let body: Record<string, any> | undefined
  const fetcher = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return Response.json(response)
    },
    { preconnect: fetch.preconnect },
  )
  return { fetcher, body: () => body }
}

const responsesResult = {
  id: "response-1",
  created_at: 0,
  model: "grok-4",
  object: "response",
  output: [],
  usage: { input_tokens: 1, output_tokens: 0 },
  status: "completed",
}

const chatResult = {
  id: "chat-1",
  created: 0,
  model: "grok-4",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

describe("xAI SDK request contracts", () => {
  test("Responses sends promptCacheKey as prompt_cache_key", async () => {
    const request = capture(responsesResult)
    const model = createXai({ apiKey: "test", fetch: request.fetcher }).responses("grok-4")

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      providerOptions: { xai: { promptCacheKey: "session-123" } },
    })

    expect(request.body()?.prompt_cache_key).toBe("session-123")
  })

  test("Responses passes through xhigh reasoning effort", async () => {
    const request = capture(responsesResult)
    const model = createXai({ apiKey: "test", fetch: request.fetcher }).responses("grok-4")

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      providerOptions: { xai: { reasoningEffort: "xhigh" } },
    })

    expect(request.body()?.reasoning).toEqual({ effort: "xhigh" })
  })

  test("Chat passes through xhigh reasoning effort", async () => {
    const request = capture(chatResult)
    const model = createXai({ apiKey: "test", fetch: request.fetcher }).chat("grok-4")

    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      providerOptions: { xai: { reasoningEffort: "xhigh" } },
    })

    expect(request.body()?.reasoning_effort).toBe("xhigh")
  })

  test("Responses serializes PDF URLs as input_file file_url", async () => {
    const request = capture(responsesResult)
    const model = createXai({ apiKey: "test", fetch: request.fetcher }).responses("grok-4")

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "file", data: new URL("https://example.com/document.pdf"), mediaType: "application/pdf" }],
        },
      ],
    })

    expect(request.body()?.input?.[0]?.content?.[0]).toEqual({
      type: "input_file",
      file_url: "https://example.com/document.pdf",
    })
  })

  test("Responses serializes xAI file IDs as input_file file_id", async () => {
    const request = capture(responsesResult)
    const model = createXai({ apiKey: "test", fetch: request.fetcher }).responses("grok-4")

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [{ type: "file", data: "file-123", mediaType: "application/pdf" }],
        },
      ],
    })

    expect(request.body()?.input?.[0]?.content?.[0]).toEqual({ type: "input_file", file_id: "file-123" })
  })

  test("Responses serializes inline PDFs with filename and data URL", async () => {
    const request = capture(responsesResult)
    const model = createXai({ apiKey: "test", fetch: request.fetcher }).responses("grok-4")

    await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "file",
              data: new Uint8Array([0, 1, 2]),
              mediaType: "application/pdf",
              filename: "document.pdf",
            },
          ],
        },
      ],
    })

    expect(request.body()?.input?.[0]?.content?.[0]).toEqual({
      type: "input_file",
      filename: "document.pdf",
      file_data: "data:application/pdf;base64,AAEC",
    })
  })
})
