import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { describe, expect, test } from "bun:test"

const encoder = new TextEncoder()

function concatBytes(chunks: readonly Uint8Array[]) {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function stringHeader(name: string, value: string) {
  const nameBytes = encoder.encode(name)
  const valueBytes = encoder.encode(value)
  const result = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length)
  const view = new DataView(result.buffer)
  result[0] = nameBytes.length
  result.set(nameBytes, 1)
  result[1 + nameBytes.length] = 7
  view.setUint16(2 + nameBytes.length, valueBytes.length, false)
  result.set(valueBytes, 4 + nameBytes.length)
  return result
}

function eventFrame(type: string, payload: object) {
  const headers = concatBytes([
    stringHeader(":message-type", "event"),
    stringHeader(":event-type", type),
    stringHeader(":content-type", "application/json"),
  ])
  const body = encoder.encode(JSON.stringify(payload))
  const length = headers.length + body.length + 16
  const result = new Uint8Array(length)
  const view = new DataView(result.buffer)
  view.setUint32(0, length, false)
  view.setUint32(4, headers.length, false)
  view.setUint32(8, crc32(result.subarray(0, 8)), false)
  result.set(headers, 12)
  result.set(body, 12 + headers.length)
  view.setUint32(length - 4, crc32(result.subarray(0, length - 4)), false)
  return result
}

function chunkedBody(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const sizes = [1, 7, 19, 3, 64]
      let offset = 0
      let index = 0
      while (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + sizes[index % sizes.length]!)
        controller.enqueue(bytes.slice(offset, end))
        offset = end
        index++
      }
      controller.close()
    },
  })
}

function bedrockModel(body: ReadableStream<Uint8Array>, capture?: (init?: RequestInit) => void) {
  const fetcher = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capture?.(init)
      return new Response(body, {
        headers: {
          "content-type": "application/vnd.amazon.eventstream",
          "x-amzn-requestid": "request-1",
        },
      })
    },
    { preconnect: fetch.preconnect },
  )
  return createAmazonBedrock({
    apiKey: "test",
    region: "us-east-1",
    baseURL: "https://bedrock.test",
    fetch: fetcher,
  })("anthropic.claude-sonnet-4-5")
}

function captureGenerateRequest() {
  let requestBody: Record<string, any> | undefined
  const fetcher = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return Response.json({
        metrics: { latencyMs: 1 },
        output: { message: { role: "assistant", content: [{ text: "Done" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
    },
    { preconnect: fetch.preconnect },
  )
  const model = createAmazonBedrock({
    apiKey: "test",
    region: "us-east-1",
    baseURL: "https://bedrock.test",
    fetch: fetcher,
  })("anthropic.claude-opus-4-6")
  return { model, body: () => requestBody }
}

const call = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
  tools: [
    {
      type: "function" as const,
      name: "lookup",
      description: "Lookup information",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    },
  ],
} satisfies LanguageModelV3CallOptions

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const events: LanguageModelV3StreamPart[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe("Amazon Bedrock SDK binary event-stream contracts", () => {
  test("replays signed reasoning, empty separators, and tool history", async () => {
    const capture = captureGenerateRequest()
    await capture.model.doGenerate({
      prompt: [
        { role: "user", content: [{ type: "text", text: "Check status" }] },
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Preserve these exact signed bytes. ",
              providerOptions: { bedrock: { signature: "sig-history-123" } },
            },
            { type: "text", text: "" },
            { type: "tool-call", toolCallId: "tool-1", toolName: "lookup", input: { query: "status" } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tool-1",
              toolName: "lookup",
              output: { type: "json", value: { status: "ok" } },
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Continue" }] },
      ],
      tools: call.tools,
    })

    expect(capture.body()?.messages).toEqual([
      { role: "user", content: [{ text: "Check status" }] },
      {
        role: "assistant",
        content: [
          {
            reasoningContent: {
              reasoningText: { text: "Preserve these exact signed bytes. ", signature: "sig-history-123" },
            },
          },
          { text: "" },
          { toolUse: { toolUseId: "tool-1", name: "lookup", input: { query: "status" } } },
        ],
      },
      {
        role: "user",
        content: [
          { toolResult: { toolUseId: "tool-1", content: [{ text: '{"status":"ok"}' }] } },
          { text: "Continue" },
        ],
      },
    ])
  })

  test("decodes reasoning, text, tool, usage, finish, and reasoning metadata", async () => {
    const bytes = concatBytes([
      eventFrame("messageStart", { role: "assistant" }),
      eventFrame("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { reasoningContent: { text: "Think carefully." } },
      }),
      eventFrame("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { reasoningContent: { signature: "sig-123" } },
      }),
      eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
      eventFrame("contentBlockStart", { contentBlockIndex: 1, start: {} }),
      eventFrame("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Checking" } }),
      eventFrame("contentBlockStop", { contentBlockIndex: 1 }),
      eventFrame("contentBlockStart", {
        contentBlockIndex: 2,
        start: { toolUse: { toolUseId: "tool-1", name: "lookup" } },
      }),
      eventFrame("contentBlockDelta", {
        contentBlockIndex: 2,
        delta: { toolUse: { input: '{"query":"status"}' } },
      }),
      eventFrame("contentBlockStop", { contentBlockIndex: 2 }),
      eventFrame("contentBlockDelta", {
        contentBlockIndex: 3,
        delta: { reasoningContent: { redactedContent: "encrypted-1" } },
      }),
      eventFrame("contentBlockDelta", {
        contentBlockIndex: 3,
        delta: { reasoningContent: { redactedContent: "-encrypted-2" } },
      }),
      eventFrame("contentBlockStop", { contentBlockIndex: 3 }),
      eventFrame("messageStop", { stopReason: "tool_use" }),
      eventFrame("metadata", {
        usage: {
          inputTokens: 5,
          outputTokens: 4,
          cacheReadInputTokens: 2,
          cacheWriteInputTokens: 1,
        },
      }),
    ])
    const result = await bedrockModel(chunkedBody(bytes)).doStream(call)
    const events = await collect(result.stream)

    expect(events.map((event) => event.type)).toEqual([
      "stream-start",
      "response-metadata",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "reasoning-start",
      "reasoning-end",
      "finish",
    ])
    expect(events).toContainEqual({ type: "reasoning-delta", id: "0", delta: "Think carefully." })
    expect(events).toContainEqual({
      type: "reasoning-delta",
      id: "0",
      delta: "",
      providerMetadata: { bedrock: { signature: "sig-123" } },
    })
    expect(events).toContainEqual({ type: "text-delta", id: "1", delta: "Checking" })
    expect(events).toContainEqual({
      type: "tool-call",
      toolCallId: "tool-1",
      toolName: "lookup",
      input: '{"query":"status"}',
    })
    expect(events).toContainEqual({
      type: "reasoning-end",
      id: "3",
      providerMetadata: { bedrock: { redactedContent: "encrypted-1-encrypted-2" } },
    })

    const finish = events.find((event) => event.type === "finish")
    expect(finish?.finishReason).toEqual({ unified: "tool-calls", raw: "tool_use" })
    expect(finish?.usage).toMatchObject({
      inputTokens: { total: 8, noCache: 5, cacheRead: 2, cacheWrite: 1 },
      outputTokens: { total: 4, text: 4 },
    })
  })

  test("fails closed on truncated frames", async () => {
    const frame = eventFrame("messageStop", { stopReason: "end_turn" })
    const result = await bedrockModel(chunkedBody(frame.subarray(0, frame.length - 1))).doStream(call)
    await expect(collect(result.stream)).rejects.toThrow("Incomplete Amazon Bedrock event-stream frame")
  })

  test("rejects frames with an invalid CRC", async () => {
    const frame = eventFrame("messageStop", { stopReason: "end_turn" }).slice()
    frame[frame.length - 5] = frame[frame.length - 5]! ^ 1
    const result = await bedrockModel(chunkedBody(frame)).doStream(call)
    await expect(collect(result.stream)).rejects.toThrow(/checksum|CRC32/i)
  })

  test("rejects frames with an invalid prelude CRC", async () => {
    const frame = eventFrame("messageStop", { stopReason: "end_turn" }).slice()
    frame[8] = frame[8]! ^ 1
    const result = await bedrockModel(chunkedBody(frame)).doStream(call)
    await expect(collect(result.stream)).rejects.toThrow(/prelude checksum/i)
  })

  test("ignores unknown events without hanging the stream", async () => {
    const bytes = concatBytes([
      eventFrame("futureEvent", { value: true }),
      eventFrame("messageStop", { stopReason: "end_turn" }),
      eventFrame("metadata", { usage: { inputTokens: 1, outputTokens: 1 } }),
    ])
    const result = await bedrockModel(chunkedBody(bytes)).doStream(call)
    const events = await collect(result.stream)

    expect(events.map((event) => event.type)).toEqual(["stream-start", "response-metadata", "finish"])
    expect(events.find((event) => event.type === "finish")?.finishReason).toEqual({
      unified: "stop",
      raw: "end_turn",
    })
  })

  test("propagates abort signals to an in-flight upstream fetch", async () => {
    let releaseFetchStarted!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      releaseFetchStarted = resolve
    })
    let capturedSignal: AbortSignal | null | undefined
    const fetcher = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        capturedSignal = init?.signal
        releaseFetchStarted()
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      },
      { preconnect: fetch.preconnect },
    )
    const model = createAmazonBedrock({
      apiKey: "test",
      region: "us-east-1",
      baseURL: "https://bedrock.test",
      fetch: fetcher,
    })("anthropic.claude-sonnet-4-5")
    const abort = new AbortController()
    const request = model.doStream({ ...call, abortSignal: abort.signal })
    await fetchStarted
    abort.abort(new DOMException("test abort", "AbortError"))

    expect(capturedSignal).toBe(abort.signal)
    await expect(request).rejects.toThrow("test abort")
  })

  test("releases the upstream reader on downstream cancel", async () => {
    let cancelCount = 0
    let releaseCancel!: () => void
    const cancelled = new Promise<void>((resolve) => {
      releaseCancel = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(eventFrame("messageStart", { role: "assistant" }))
      },
      cancel() {
        cancelCount++
        releaseCancel()
      },
    })
    const result = await bedrockModel(body).doStream(call)

    const reader = result.stream.getReader()
    await reader.read()
    await reader.cancel("downstream closed")
    await cancelled
    await reader.cancel("already closed")
    for (let attempt = 0; attempt < 10 && body.locked; attempt++) await Bun.sleep(1)
    expect(cancelCount).toBe(1)
    expect(body.locked).toBe(false)
  })
})
