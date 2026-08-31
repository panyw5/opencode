import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createVertex } from "@ai-sdk/google-vertex"
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"
import { describe, expect, test } from "bun:test"

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, any>
}

function eventResponse(...chunks: object[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function fixtureFetch(responses: Response[], captures: Capture[]) {
  return Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      captures.push({
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      })
      const response = responses.shift()
      if (!response) throw new Error(`Unexpected provider request: ${url}`)
      return response
    },
    { preconnect: fetch.preconnect },
  )
}

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const events: LanguageModelV3StreamPart[] = []
  for await (const event of stream) events.push(event)
  return events
}

const tools = [
  {
    type: "function",
    name: "lookup_weather",
    description: "Look up the current weather",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
] satisfies NonNullable<LanguageModelV3CallOptions["tools"]>

const providers = [
  {
    name: "Google",
    namespace: "google",
    make(fetcher: typeof fetch, generateId: () => string) {
      return createGoogleGenerativeAI({
        name: "google",
        apiKey: "test-google-key",
        baseURL: "https://fixture.invalid/google/v1beta",
        fetch: fetcher,
        generateId,
      })("gemini-3-flash-preview")
    },
  },
  {
    name: "Vertex",
    namespace: "vertex",
    make(fetcher: typeof fetch, generateId: () => string) {
      return createVertex({
        apiKey: "test-vertex-key",
        baseURL: "https://fixture.invalid/vertex/v1/publishers/google",
        fetch: fetcher,
        generateId,
      })("gemini-3-flash-preview")
    },
  },
] satisfies Array<{
  name: string
  namespace: "google" | "vertex"
  make: (fetcher: typeof fetch, generateId: () => string) => LanguageModelV3
}>

describe("Google and Vertex SDK replay contracts", () => {
  for (const provider of providers) {
    test(`${provider.name} preserves streamed thought signatures through tool-result continuation`, async () => {
      const captures: Capture[] = []
      let id = 0
      const model = provider.make(
        fixtureFetch(
          [
            eventResponse({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        text: "I should query the weather tool.",
                        thought: true,
                        thoughtSignature: "sig-thought-001",
                      },
                      {
                        functionCall: { name: "lookup_weather", args: { city: "Paris" } },
                        thoughtSignature: "sig-tool-001",
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
            }),
            eventResponse({
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "It is 21°C and sunny." }] },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5, totalTokenCount: 13 },
            }),
          ],
          captures,
        ),
        () => `call-${++id}`,
      )

      const first = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "What is the weather in Paris?" }] }],
        tools,
      })
      const firstEvents = await collect(first.stream)
      expect(
        firstEvents
          .map((event) => event.type)
          .filter((type) => type.startsWith("reasoning-") || type.startsWith("tool-") || type === "finish"),
      ).toEqual([
        "reasoning-start",
        "reasoning-delta",
        "tool-input-start",
        "tool-input-delta",
        "tool-input-end",
        "tool-call",
        "reasoning-end",
        "finish",
      ])
      const reasoning = firstEvents.find((event) => event.type === "reasoning-delta")
      const call = firstEvents.find((event) => event.type === "tool-call")
      if (!reasoning || !call) throw new Error("Expected streamed reasoning and tool call")

      expect(reasoning.providerMetadata).toEqual({
        [provider.namespace]: { thoughtSignature: "sig-thought-001" },
      })
      expect(call).toMatchObject({
        type: "tool-call",
        toolName: "lookup_weather",
        input: '{"city":"Paris"}',
        providerMetadata: { [provider.namespace]: { thoughtSignature: "sig-tool-001" } },
      })
      expect(firstEvents.find((event) => event.type === "finish")?.finishReason).toEqual({
        unified: "tool-calls",
        raw: "STOP",
      })

      const second = await model.doStream({
        prompt: [
          { role: "user", content: [{ type: "text", text: "What is the weather in Paris?" }] },
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: reasoning.delta,
                providerOptions: reasoning.providerMetadata,
              },
              {
                type: "tool-call",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: JSON.parse(call.input),
                providerOptions: call.providerMetadata,
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: { type: "json", value: { temperatureC: 21, condition: "sunny" } },
              },
            ],
          },
        ],
        tools,
      })
      const secondEvents = await collect(second.stream)

      expect(secondEvents.find((event) => event.type === "text-delta")).toMatchObject({
        type: "text-delta",
        delta: "It is 21°C and sunny.",
      })
      expect(captures).toHaveLength(2)
      expect(captures[1]?.body.contents).toEqual([
        { role: "user", parts: [{ text: "What is the weather in Paris?" }] },
        {
          role: "model",
          parts: [
            {
              text: "I should query the weather tool.",
              thought: true,
              thoughtSignature: "sig-thought-001",
            },
            {
              functionCall: { name: "lookup_weather", args: { city: "Paris" } },
              thoughtSignature: "sig-tool-001",
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "lookup_weather",
                response: { name: "lookup_weather", content: { temperatureC: 21, condition: "sunny" } },
              },
            },
          ],
        },
      ])
      expect(JSON.stringify(captures[1]?.body.contents)).not.toContain(call.toolCallId)
      expect(captures.every((capture) => capture.url.hostname === "fixture.invalid")).toBe(true)
    })
  }

  test("Vertex streams a signed no-args function call without dropping it", async () => {
    const captures: Capture[] = []
    const model = providers[1]!.make(
      fixtureFetch(
        [
          eventResponse({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    {
                      functionCall: { name: "get_current_time" },
                      thoughtSignature: "sig-noargs-001",
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          }),
        ],
        captures,
      ),
      () => "call-noargs-1",
    )
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "What time is it?" }] }],
      tools: [
        {
          type: "function",
          name: "get_current_time",
          description: "Return the current time",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    })
    const events = await collect(result.stream)
    const toolEvents = events.filter(
      (event) => event.type.startsWith("tool-input-") || event.type === "tool-call" || event.type === "finish",
    )

    expect(toolEvents.map((event) => event.type)).toEqual(["tool-input-start", "tool-input-end", "tool-call", "finish"])
    expect(events.some((event) => event.type === "tool-input-delta")).toBe(false)
    expect(toolEvents.slice(0, 3)).toMatchObject([
      {
        type: "tool-input-start",
        id: "call-noargs-1",
        toolName: "get_current_time",
        providerMetadata: { vertex: { thoughtSignature: "sig-noargs-001" } },
      },
      {
        type: "tool-input-end",
        id: "call-noargs-1",
        providerMetadata: { vertex: { thoughtSignature: "sig-noargs-001" } },
      },
      {
        type: "tool-call",
        toolCallId: "call-noargs-1",
        toolName: "get_current_time",
        input: "{}",
        providerMetadata: { vertex: { thoughtSignature: "sig-noargs-001" } },
      },
    ])
    expect(toolEvents.at(-1)).toMatchObject({
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "STOP" },
    })
    expect(captures).toHaveLength(1)
    expect(captures[0]?.headers.get("x-goog-api-key")).toBe("test-vertex-key")
    expect(captures[0]?.headers.has("authorization")).toBe(false)
    expect(captures[0]?.url.hostname).toBe("fixture.invalid")
  })
})
