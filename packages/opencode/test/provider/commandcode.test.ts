import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { commandCodeCustomLoader, resolveCommandCodeRuntimeAuth } from "../../src/plugin/commandcode"
import { createCommandCodeLanguageModel } from "../../src/provider/commandcode"

function input() {
  return {
    prompt: [
      { role: "system" as const, content: "Be concise." },
      { role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] },
    ],
  }
}

describe("commandcode runtime auth", () => {
  test("does not treat the Command Code CLI auth file as a signed-in OpenCode session", () => {
    expect(resolveCommandCodeRuntimeAuth({ stored: undefined, envKey: undefined })).toEqual({})
    expect(
      resolveCommandCodeRuntimeAuth({
        stored: { type: "api", key: "user_stored" },
        envKey: "user_env",
      }),
    ).toEqual({ key: "user_stored", source: "auth" })
    expect(resolveCommandCodeRuntimeAuth({ stored: undefined, envKey: "user_env" })).toEqual({
      key: "user_env",
      source: "env",
    })
  })

  test("custom loader does not autoload from ~/.commandcode/auth.json", async () => {
    const load = commandCodeCustomLoader({
      auth: () => Effect.succeed(undefined),
      env: () => Effect.succeed({}),
    })
    const result = await Effect.runPromise(load())
    expect(result.autoload).toBe(false)
    expect(result.options).toEqual({})
  })

  test("custom loader autoloads stored OpenCode auth", async () => {
    const load = commandCodeCustomLoader({
      auth: () => Effect.succeed({ type: "api", key: "user_stored" }),
      env: () => Effect.succeed({}),
    })
    const result = await Effect.runPromise(load())
    expect(result.autoload).toBe(true)
    expect(result.options).toEqual({ apiKey: "user_stored" })
  })
})

describe("commandcode language model", () => {
  test("translates Command Code JSONL into AI SDK stream parts", async () => {
    let request: Request | undefined
    const model = createCommandCodeLanguageModel("gpt-5.5", {
      apiKey: "user_test_key",
      apiBase: "https://commandcode.test",
      workingDirectory: "/tmp/project",
      fetchImpl: async (input, init) => {
        request = new Request(input, init)
        return new Response(
          [
            JSON.stringify({ type: "reasoning-delta", text: "Think" }),
            JSON.stringify({ type: "text-delta", text: "Hello" }),
            JSON.stringify({ type: "tool-call", toolCallId: "call-1", toolName: "read", input: { path: "a" } }),
            JSON.stringify({ type: "finish", finishReason: "tool-calls", totalUsage: { outputTokens: 3 } }),
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "application/jsonl" } },
        )
      },
    })

    const result = await model.doStream(input())
    const reader = result.stream.getReader()
    const parts = []
    while (true) {
      const next = await reader.read()
      if (next.done) break
      parts.push(next.value)
    }

    expect(request?.url).toBe("https://commandcode.test/alpha/generate")
    expect(request?.headers.get("authorization")).toBe("Bearer user_test_key")
    expect(request?.headers.get("x-command-code-version")).toBe("1.28.1")
    expect(request?.headers.get("x-project-slug")).toBe("tmp-project")
    const body = (await request?.clone().json()) as Record<string, any>
    expect(body.config.workingDir).toBe("/tmp/project")
    expect(body.params.model).toBe("gpt-5.5")
    expect(body.params.system).toBe("Be concise.")
    expect(body.params.max_tokens).toBe(64_000)
    expect(parts.map((part) => part.type)).toEqual([
      "stream-start",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "finish",
    ])
    expect(parts.at(-1)).toMatchObject({ finishReason: { unified: "tool-calls" } })
  })

  test("surfaces provider HTTP errors", async () => {
    const model = createCommandCodeLanguageModel("gpt-5.5", {
      apiKey: "user_test_key",
      fetchImpl: async () => new Response("invalid key", { status: 401 }),
    })

    await expect(model.doStream(input())).rejects.toThrow("Command Code API error 401: invalid key")
  })

  test("surfaces provider stream errors", async () => {
    const model = createCommandCodeLanguageModel("gpt-5.5", {
      apiKey: "user_test_key",
      fetchImpl: async () =>
        new Response(
          `${JSON.stringify({ type: "start" })}\n${JSON.stringify({ type: "error", error: { message: "quota exhausted" } })}\n`,
          { status: 200 },
        ),
    })

    const result = await model.doStream(input())
    const reader = result.stream.getReader()
    await reader.read()
    await expect(reader.read()).rejects.toThrow("Command Code stream error: quota exhausted")
  })

  test("closes the stream in the same pull that receives finish", async () => {
    const model = createCommandCodeLanguageModel("gpt-5.5", {
      apiKey: "user_test_key",
      fetchImpl: async () =>
        new Response(
          [
            JSON.stringify({ type: "text-delta", text: "done" }),
            JSON.stringify({ type: "finish", finishReason: "stop" }),
          ].join("\n"),
          { status: 200 },
        ),
    })

    const result = await model.doStream(input())
    const readAll = (async () => {
      const reader = result.stream.getReader()
      const parts = []
      while (true) {
        const next = await reader.read()
        if (next.done) return parts
        parts.push(next.value)
      }
    })()
    const parts = await Promise.race([
      readAll,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not close")), 1000)),
    ])

    expect(parts.at(-1)?.type).toBe("finish")
  })

  test("fails a stream that stays idle after receiving data", async () => {
    const model = createCommandCodeLanguageModel("gpt-5.5", {
      apiKey: "user_test_key",
      streamIdleTimeoutMs: 20,
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "start" })}\n`))
            },
            pull() {
              return new Promise(() => {})
            },
          }),
          { status: 200 },
        ),
    })

    const result = await model.doStream(input())
    const reader = result.stream.getReader()
    await reader.read()
    await expect(
      Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not timeout")), 1000)),
      ]),
    ).rejects.toThrow("Command Code stream idle timeout after 20ms")
  })

  test("stops reading when the caller aborts", async () => {
    const abort = new AbortController()
    const model = createCommandCodeLanguageModel("gpt-5.5", {
      apiKey: "user_test_key",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "start" })}\n`))
            },
            pull() {
              return new Promise(() => {})
            },
          }),
          { status: 200 },
        ),
    })

    const result = await model.doStream({ ...input(), abortSignal: abort.signal })
    const reader = result.stream.getReader()
    await reader.read()
    abort.abort(new DOMException("Aborted", "AbortError"))
    await expect(
      Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream did not abort")), 1000)),
      ]),
    ).rejects.toThrow("Aborted")
  })
})
