import { describe, expect, test } from "bun:test"
import {
  canStreamRequestBody,
  prepareRequestBody,
  readRequestJson,
  responseIsStreaming,
  streamRequestBody,
} from "../src/routes/zen/util/requestBody"

function chunked(bytes: Uint8Array, size = 1) {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close()
        return
      }
      controller.enqueue(bytes.slice(offset, (offset += size)))
    },
  })
}

describe("Zen request body streaming eligibility", () => {
  test("streams only same-format requests without modifiers", () => {
    const base = {
      requestFormat: "oa-compat",
      providerFormat: "oa-compat",
      providerModel: "provider-model",
      hasPayloadModifier: false,
      alreadyBuffered: false,
      contentLength: undefined,
    }

    expect(canStreamRequestBody(base)).toBe(true)
    expect(canStreamRequestBody({ ...base, providerFormat: "openai" })).toBe(false)
    expect(canStreamRequestBody({ ...base, hasPayloadModifier: true })).toBe(false)
    expect(canStreamRequestBody({ ...base, alreadyBuffered: true })).toBe(false)
    expect(canStreamRequestBody({ ...base, contentLength: 1024 })).toBe(false)
    expect(canStreamRequestBody({ ...base, contentLength: 2 * 1024 * 1024 })).toBe(true)
  })

  test("buffers Anthropic providers that require body conversion", () => {
    const base = {
      requestFormat: "anthropic",
      providerFormat: "anthropic",
      hasPayloadModifier: false,
      alreadyBuffered: false,
      contentLength: undefined,
    }

    expect(canStreamRequestBody({ ...base, providerModel: "claude-sonnet-4-6" })).toBe(true)
    expect(canStreamRequestBody({ ...base, providerModel: "global.anthropic.claude-sonnet" })).toBe(false)
    expect(canStreamRequestBody({ ...base, providerModel: "arn:aws:bedrock:us-east-1:model" })).toBe(false)
    expect(canStreamRequestBody({ ...base, providerModel: "databricks-claude-sonnet" })).toBe(false)
  })

  test("classifies response streams by protocol", () => {
    expect(responseIsStreaming("google", true, "application/json")).toBe(true)
    expect(responseIsStreaming("google", false, "text/event-stream")).toBe(false)
    expect(responseIsStreaming("oa-compat", false, "text/event-stream; charset=utf-8")).toBe(true)
    expect(responseIsStreaming("anthropic", false, "application/vnd.amazon.eventstream")).toBe(true)
    expect(responseIsStreaming("oa-compat", true, "application/json")).toBe(false)
  })
})

describe("Zen request body streaming", () => {
  test("cancels model scanning when the caller aborts", async () => {
    const caller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {})
      },
    })
    const pending = prepareRequestBody(body, caller.signal)

    caller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("cancels buffered modifier parsing when the caller aborts", async () => {
    const caller = new AbortController()
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(new TextEncoder().encode('{"model":"client-model","messages":['))
          return
        }
        return new Promise<void>(() => {})
      },
    })
    const pending = readRequestJson(body, caller.signal)
    await Promise.resolve()

    caller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("patches the leading model without buffering the remaining body", async () => {
    let reads = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunks = [
            '{"model":"client-model","stream":true,"messages":[',
            JSON.stringify({ role: "user", content: "large payload" }),
            "]}",
          ]
          const chunk = chunks[reads++]
          if (chunk) controller.enqueue(new TextEncoder().encode(chunk))
          else controller.close()
        },
      },
      { highWaterMark: 0 },
    )

    const request = await prepareRequestBody(body)
    expect(request.model).toBe("client-model")
    expect(reads).toBe(1)

    const output = await new Response(request.stream("provider-model", false)).text()
    expect(JSON.parse(output)).toEqual({
      model: "provider-model",
      stream: true,
      messages: [{ role: "user", content: "large payload" }],
    })
  })

  test("appends stream usage options before trailing whitespace", async () => {
    const body = new Blob(['{"model":"client-model","stream":true,"messages":[]}   ']).stream()
    const request = await prepareRequestBody(body)
    const output = await new Response(request.stream("provider-model", true)).text()

    expect(JSON.parse(output)).toEqual({
      model: "provider-model",
      stream: true,
      messages: [],
      stream_options: { include_usage: true },
    })
    expect(output.endsWith("   ")).toBe(true)
  })

  test("detects streaming after a large message while forwarding", async () => {
    const content = "x".repeat(128 * 1024)
    let reads = 0
    const chunks = [
      '{"model":"client-model","messages":[',
      JSON.stringify({ role: "user", content }),
      '],"stream":true}',
    ]
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[reads++]
          if (chunk) controller.enqueue(new TextEncoder().encode(chunk))
          else controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const request = await prepareRequestBody(body)
    expect(reads).toBe(1)
    const output = await new Response(request.stream("provider-model", true)).text()

    expect(JSON.parse(output)).toEqual({
      model: "provider-model",
      messages: [{ role: "user", content }],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  test("buffers through a late model field and then streams the rest", async () => {
    const content = "こんにちは".repeat(32 * 1024)
    let reads = 0
    const chunks = [
      '{"messages":[',
      JSON.stringify({ role: "user", content }),
      '],"model":"client-model","stream":true,"extra":"after-model"}',
    ]
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[reads++]
          if (chunk) controller.enqueue(new TextEncoder().encode(chunk))
          else controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const request = await prepareRequestBody(body)

    expect(request.model).toBe("client-model")
    expect(reads).toBe(3)
    expect(JSON.parse(await new Response(request.stream("provider-model", true)).text())).toEqual({
      messages: [{ role: "user", content }],
      model: "provider-model",
      stream: true,
      extra: "after-model",
      stream_options: { include_usage: true },
    })
  })

  test("preserves a UTF-8 BOM while patching the model", async () => {
    const body = new Blob(['\uFEFF{"messages":[],"model":"client-model","stream":false}']).stream()
    const request = await prepareRequestBody(body)
    const output = new Uint8Array(await new Response(request.stream("provider-model", false)).arrayBuffer())

    expect([...output.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(JSON.parse(new TextDecoder().decode(output))).toEqual({
      messages: [],
      model: "provider-model",
      stream: false,
    })
  })

  test("preserves a BOM split across one-byte chunks", async () => {
    const bytes = new TextEncoder().encode('\uFEFF{"messages":[],"model":"client-model","stream":false}')
    const request = await prepareRequestBody(chunked(bytes))
    const output = new Uint8Array(await new Response(request.stream("provider-model", false)).arrayBuffer())

    expect([...output.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(JSON.parse(new TextDecoder().decode(output)).model).toBe("provider-model")
  })

  test("ignores nested model fields and decodes escaped root model", async () => {
    const input = '{"metadata":{"model":"nested-model"},"note":"こんにちは","model":"client-\\u2603","stream":false}'
    const request = await prepareRequestBody(chunked(new TextEncoder().encode(input), 3))

    expect(request.model).toBe("client-☃")
    expect(JSON.parse(await new Response(request.stream('provider-"quoted"', false)).text())).toEqual({
      metadata: { model: "nested-model" },
      note: "こんにちは",
      model: 'provider-"quoted"',
      stream: false,
    })
  })

  test("rejects duplicate root model fields", async () => {
    const input = '{"model":"cheap-model","messages":[],"model":"expensive-model","stream":false}'
    const request = await prepareRequestBody(chunked(new TextEncoder().encode(input), 7))
    expect(request.model).toBe("cheap-model")
    await expect(new Response(request.stream("selected-provider-model", false)).text()).rejects.toThrow(
      "Request body must contain exactly one root model field",
    )
  })

  test("rejects duplicate root model keys with a non-string override", async () => {
    const input = '{"model":"cheap-model","messages":[],"model":123,"stream":false}'
    const request = await prepareRequestBody(chunked(new TextEncoder().encode(input), 7))

    await expect(new Response(request.stream("selected-provider-model", false)).text()).rejects.toThrow(
      "Request body must contain exactly one root model field",
    )
  })

  test("rejects oversized source chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
    })

    await expect(prepareRequestBody(body)).rejects.toThrow("Request body chunk exceeds streaming limit")
  })

  test("rejects oversized chunks after the model prefix", async () => {
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) {
          controller.enqueue(new TextEncoder().encode('{"model":"client-model","messages":["'))
          return
        }
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
    })
    const request = await prepareRequestBody(body)

    await expect(new Response(request.stream("provider-model", false)).text()).rejects.toThrow(
      "Request body chunk exceeds streaming limit",
    )
  })

  test("limits chunks for direct Google request bodies", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
    })

    await expect(new Response(streamRequestBody(body)).arrayBuffer()).rejects.toThrow(
      "Request body chunk exceeds streaming limit",
    )
  })

  test("rejects model fields beyond the bounded streaming prefix", async () => {
    const input = `{"padding":"${"x".repeat(1024 * 1024)}","model":"too-late"}`

    await expect(prepareRequestBody(new Blob([input]).stream())).rejects.toThrow(
      "Model field exceeds streaming prefix limit",
    )
  })

  test("uses the root stream flag and preserves long trailing whitespace", async () => {
    const whitespace = " ".repeat(8 * 1024)
    const input = `${JSON.stringify({
      model: "client-model",
      stream: true,
      metadata: { stream: false },
      stream_options: { include_usage: false },
    })}${whitespace}`
    const request = await prepareRequestBody(chunked(new TextEncoder().encode(input), 257))
    const output = await new Response(request.stream("provider-model", true)).text()

    expect(JSON.parse(output)).toEqual({
      model: "provider-model",
      stream: true,
      metadata: { stream: false },
      stream_options: { include_usage: true },
    })
    expect(output.endsWith(whitespace)).toBe(true)
  })

  test("materializes the original body for provider modifiers", async () => {
    const request = await prepareRequestBody(new Blob(['{"model":"client-model","messages":[]}']).stream())

    expect(await request.json()).toEqual({ model: "client-model", messages: [] })
    expect(() => request.stream("provider-model", false)).toThrow("Request body stream already consumed")
  })
})
