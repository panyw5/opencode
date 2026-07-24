import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import {
  applyGrokJsonlLine,
  buildGrokExecArgs,
  buildGrokResumeArgs,
  createGrokLiveState,
  Parameters,
  parseGrokJsonl,
  resolveTimeoutMs,
} from "../../src/tool/grok_consult"

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

describe("tool.grok_consult helpers", () => {
  test("buildGrokResumeArgs enables the full tool set while resuming", () => {
    expect(
      buildGrokResumeArgs({ sessionId: "session_abc", prompt: "Follow up", workingDirectory: "/tmp/project" }),
    ).toEqual([
      "--single",
      "Follow up",
      "--resume",
      "session_abc",
      "--cwd",
      "/tmp/project",
      "--output-format",
      "streaming-json",
      "--permission-mode",
      "bypassPermissions",
    ])
  })

  test("buildGrokExecArgs enables non-interactive full-tool execution", () => {
    const args = buildGrokExecArgs({
      prompt: "Review auth flow",
      workingDirectory: "/tmp/project",
      model: "grok-build",
    })
    expect(args).toContain("--single")
    expect(args).toContain("--output-format")
    expect(args).toContain("streaming-json")
    expect(args).toContain("--permission-mode")
    expect(args).toContain("bypassPermissions")
    expect(args).not.toContain("--tools")
    expect(args).not.toContain("--disallowed-tools")
    expect(args).toContain("--cwd")
    expect(args).toContain("/tmp/project")
    expect(args).toContain("--model")
    expect(args).toContain("grok-build")
    const promptArg = args[1]!
    expect(promptArg).toContain("Review auth flow")
    expect(promptArg).toContain("external implementation agent")
    expect(promptArg).toContain("modify files")
  })

  test("buildGrokExecArgs omits model flag when unset", () => {
    expect(buildGrokExecArgs({ prompt: "hello", workingDirectory: "/repo" })).not.toContain("--model")
  })

  test("parseGrokJsonl extracts text, session id, tool calls, and errors", () => {
    const stdout = [
      JSON.stringify({ type: "text", data: "Draft " }),
      JSON.stringify({ type: "tool_call", id: "read-1", name: "read_file", input: { path: "/tmp/a" } }),
      JSON.stringify({ type: "text", data: "answer" }),
      JSON.stringify({ type: "end", sessionId: "session_abc", stopReason: "EndTurn" }),
    ].join("\n")

    const parsed = parseGrokJsonl(stdout)
    expect(parsed.sessionId).toBe("session_abc")
    expect(parsed.finalResponse).toBe("Draft answer")
    expect(parsed.error).toBeUndefined()
    expect(parsed.transcript.some((item) => item.kind === "tool_use" && item.title === "read_file")).toBe(true)
  })

  test("applyGrokJsonlLine builds a live transcript stream", () => {
    const state = createGrokLiveState()
    expect(applyGrokJsonlLine(state, JSON.stringify({ type: "thought", data: "Inspecting " }))).toBe(true)
    expect(applyGrokJsonlLine(state, JSON.stringify({ type: "thought", data: "files" }))).toBe(true)
    expect(applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "done" }))).toBe(true)
    expect(applyGrokJsonlLine(state, JSON.stringify({ type: "end", sessionId: "session_1" }))).toBe(true)
    expect(state.sessionId).toBe("session_1")
    expect(state.preview).toBe("done")
    const thinking = state.transcript.filter((item) => item.kind === "thinking")
    expect(thinking).toEqual([
      expect.objectContaining({ text: "Inspecting files", status: "completed" }),
    ])
    expect(state.transcript.some((item) => item.kind === "message" && item.text === "done")).toBe(true)
  })

  test("applyGrokJsonlLine keeps an interleaved assistant stream after later thinking", () => {
    const state = createGrokLiveState()
    applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "Draft answer" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "thought", data: "Checking sources" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "end", sessionId: "session_1" }))

    expect(state.transcript.map((item) => item.kind)).toEqual(["thinking", "message", "status"])
    expect(state.transcript.find((item) => item.id === "assistant:stream")).toMatchObject({ status: "completed" })
    expect(state.transcript.find((item) => item.title === "Turn completed")?.text).toBeUndefined()
  })

  test("parseGrokJsonl captures error events and ignores non-json noise", () => {
    const parsed = parseGrokJsonl(["not json", JSON.stringify({ type: "error", message: "auth expired" })].join("\n"))
    expect(parsed.error).toBe("auth expired")
    expect(parsed.finalResponse).toBe("")
  })

  test("resolveTimeoutMs clamps bounds", () => {
    expect(resolveTimeoutMs(undefined)).toBe(10 * 60 * 1000)
    expect(resolveTimeoutMs(100)).toBe(30 * 1000)
    expect(resolveTimeoutMs(999999999)).toBe(30 * 60 * 1000)
    expect(resolveTimeoutMs(120_000)).toBe(120_000)
  })
})

describe("tool.grok_consult parameters", () => {
  test("JSON schema has the expected public shape", () => {
    const schema = ToolJsonSchema.fromSchema(Parameters)
    expect(schema).toMatchObject({
      type: "object",
      required: ["prompt"],
      properties: { prompt: { type: "string" } },
    })
    expect(schema.properties).toHaveProperty("working_directory")
    expect(schema.properties).toHaveProperty("model")
    expect(schema.properties).toHaveProperty("timeout_ms")
  })

  test("accepts prompt-only and rejects an empty object", () => {
    expect(accepts(Parameters, { prompt: "review this" })).toBe(true)
    expect(accepts(Parameters, {})).toBe(false)
    expect(parse(Parameters, { prompt: "x", model: "grok-build" }).model).toBe("grok-build")
  })
})
