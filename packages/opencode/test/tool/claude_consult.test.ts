import { describe, expect, test } from "bun:test"
import {
  applyClaudeJsonlLine,
  buildClaudeExecArgs,
  createClaudeLiveState,
  parseClaudeJsonl,
  resolveTimeoutMs,
  Parameters,
} from "../../src/tool/claude_consult"
import { Result, Schema } from "effect"
import { ToolJsonSchema } from "../../src/tool/json-schema"

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

describe("tool.claude_consult helpers", () => {
  test("buildClaudeExecArgs forces non-interactive read-only tools", () => {
    const args = buildClaudeExecArgs({
      prompt: "Review auth flow",
      workingDirectory: "/tmp/project",
      model: "sonnet",
    })
    expect(args).toContain("-p")
    expect(args).toContain("--output-format")
    expect(args).toContain("stream-json")
    expect(args).toContain("--permission-mode")
    expect(args).toContain("dontAsk")
    expect(args).toContain("--no-session-persistence")
    expect(args).toContain("--safe-mode")
    expect(args).toContain("--tools")
    expect(args).toContain("Read,Grep,Glob,LS")
    expect(args).toContain("--add-dir")
    expect(args).toContain("/tmp/project")
    expect(args).toContain("--model")
    expect(args).toContain("sonnet")
    expect(args).not.toContain("--dangerously-skip-permissions")
    const promptArg = args.at(-1)!
    expect(promptArg).toContain("Review auth flow")
    expect(promptArg).toContain("external advisor")
    expect(promptArg).toContain("read-only")
  })

  test("buildClaudeExecArgs omits model flag when unset", () => {
    const args = buildClaudeExecArgs({
      prompt: "hello",
      workingDirectory: "/repo",
    })
    expect(args).not.toContain("--model")
  })

  test("parseClaudeJsonl extracts final result and usage", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess_abc" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Draft answer" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "sess_abc",
        result: "Final answer",
        usage: { input_tokens: 10, output_tokens: 20 },
        total_cost_usd: 0.05,
        duration_ms: 1234,
      }),
    ].join("\n")

    const parsed = parseClaudeJsonl(stdout)
    expect(parsed.sessionId).toBe("sess_abc")
    expect(parsed.finalResponse).toBe("Final answer")
    expect(parsed.agentMessages).toEqual(["Draft answer", "Final answer"])
    expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 20 })
    expect(parsed.costUsd).toBe(0.05)
    expect(parsed.durationMs).toBe(1234)
    expect(parsed.error).toBeUndefined()
  })

  test("parseClaudeJsonl captures result failure", () => {
    const stdout = [
      JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "auth expired" }),
    ].join("\n")
    const parsed = parseClaudeJsonl(stdout)
    expect(parsed.error).toBe("auth expired")
    expect(parsed.finalResponse).toBe("auth expired")
  })

  test("parseClaudeJsonl ignores non-json noise lines", () => {
    const stdout = ["not json", JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }), ""].join(
      "\n",
    )
    const parsed = parseClaudeJsonl(stdout)
    expect(parsed.sessionId).toBe("s1")
    expect(parsed.finalResponse).toBe("")
  })

  test("applyClaudeJsonlLine builds a live transcript stream", () => {
    const state = createClaudeLiveState()
    expect(
      applyClaudeJsonlLine(state, JSON.stringify({ type: "system", subtype: "init", session_id: "sess_1" })),
    ).toBe(true)
    expect(
      applyClaudeJsonlLine(
        state,
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { id: "tool1", type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
              { id: "m1", type: "text", text: "done" },
            ],
          },
        }),
      ),
    ).toBe(true)
    expect(state.sessionId).toBe("sess_1")
    expect(state.preview).toBe("done")
    expect(state.transcript.some((item) => item.kind === "tool_use" && item.title === "Read")).toBe(true)
    expect(state.transcript.some((item) => item.kind === "message" && item.text === "done")).toBe(true)
  })

  test("resolveTimeoutMs clamps bounds", () => {
    expect(resolveTimeoutMs(undefined)).toBe(10 * 60 * 1000)
    expect(resolveTimeoutMs(100)).toBe(30 * 1000)
    expect(resolveTimeoutMs(999999999)).toBe(30 * 60 * 1000)
    expect(resolveTimeoutMs(120_000)).toBe(120_000)
  })
})

describe("tool.claude_consult parameters", () => {
  test("JSON schema snapshot shape", () => {
    const schema = ToolJsonSchema.fromSchema(Parameters)
    expect(schema).toMatchObject({
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
      },
    })
    expect(schema.properties).toHaveProperty("working_directory")
    expect(schema.properties).toHaveProperty("model")
    expect(schema.properties).toHaveProperty("timeout_ms")
  })

  test("accepts prompt-only and rejects empty object", () => {
    expect(accepts(Parameters, { prompt: "review this" })).toBe(true)
    expect(accepts(Parameters, {})).toBe(false)
    expect(parse(Parameters, { prompt: "x", model: "sonnet" }).model).toBe("sonnet")
  })
})
