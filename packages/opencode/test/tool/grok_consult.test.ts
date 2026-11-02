import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { ToolJsonSchema } from "../../src/tool/json-schema"
import {
  applyGrokJsonlLine,
  beginGrokTurn,
  buildGrokExecArgs,
  buildGrokResumeArgs,
  createGrokLiveState,
  Parameters,
  parseGrokJsonl,
  resolveTimeoutMs,
} from "../../src/tool/grok_consult"
import { externalTurnFailure } from "../../src/tool/external-cli"

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
    expect(
      applyGrokJsonlLine(state, JSON.stringify({ type: "end", sessionId: "session_1", stopReason: "EndTurn" })),
    ).toBe(true)
    expect(state.sessionId).toBe("session_1")
    expect(state.preview).toBe("done")
    const thinking = state.transcript.filter((item) => item.kind === "thinking")
    expect(thinking).toEqual([expect.objectContaining({ text: "Inspecting files", status: "completed" })])
    expect(state.transcript.some((item) => item.kind === "message" && item.text === "done")).toBe(true)
  })

  test("applyGrokJsonlLine keeps transcript entries in chronological order when thinking interrupts the reply", () => {
    const state = createGrokLiveState()
    applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "Draft answer" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "thought", data: "Checking sources" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "end", sessionId: "session_1", stopReason: "EndTurn" }))

    expect(state.transcript.map((item) => item.kind)).toEqual(["message", "thinking", "status"])
    expect(state.transcript.find((item) => item.kind === "message")).toMatchObject({
      id: "assistant:1",
      status: "completed",
    })
    expect(state.transcript.find((item) => item.title === "Turn completed")?.text).toBeUndefined()
  })

  test("applyGrokJsonlLine segments the reply around interleaved tool calls", () => {
    const state = createGrokLiveState()
    applyGrokJsonlLine(state, JSON.stringify({ type: "thought", data: "Plan first" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "Let me check " }))
    applyGrokJsonlLine(
      state,
      JSON.stringify({ type: "tool_call", id: "read-1", name: "read_file", input: { path: "/a" } }),
    )
    applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "the file" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "end", sessionId: "session_1", stopReason: "end_turn" }))

    expect(state.transcript.map((item) => item.kind)).toEqual(["thinking", "message", "tool_use", "message", "status"])
    const segments = state.transcript.filter((item) => item.kind === "message")
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ id: "assistant:1", text: "Let me check ", status: "completed" })
    expect(segments[1]).toMatchObject({ id: "assistant:2", text: "the file", status: "completed" })
    expect(state.assistantText).toBe("Let me check the file")
    expect(state.preview).toBe("Let me check the file")
  })

  test("applyGrokJsonlLine tracks real tool_call and tool_call_update events", () => {
    const state = createGrokLiveState()
    applyGrokJsonlLine(
      state,
      JSON.stringify({
        type: "tool_call",
        toolCallId: "call-abc-0",
        title: "run_terminal_command",
        kind: "execute",
        status: "pending",
        toolName: "run_terminal_command",
        rawInput: { command: "date", description: "Get current date" },
      }),
    )
    applyGrokJsonlLine(
      state,
      JSON.stringify({
        type: "tool_call_update",
        toolCallId: "call-abc-0",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "" } }],
      }),
    )
    applyGrokJsonlLine(
      state,
      JSON.stringify({
        type: "tool_call_update",
        toolCallId: "call-abc-0",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "2026-09-27 Sunday" } }],
      }),
    )

    const tool = state.transcript.find((item) => item.kind === "tool_use")
    expect(tool).toMatchObject({
      id: "call-abc-0",
      title: "run_terminal_command",
      status: "completed",
    })
    expect(tool?.text).toContain("date")
    expect(tool?.text).toContain("2026-09-27 Sunday")
  })

  test("applyGrokJsonlLine ignores tool_call_update without a matching tool_call", () => {
    const state = createGrokLiveState()
    expect(
      applyGrokJsonlLine(
        state,
        JSON.stringify({ type: "tool_call_update", toolCallId: "missing", status: "completed" }),
      ),
    ).toBe(false)
    expect(state.transcript).toEqual([])
  })

  test("parseGrokJsonl captures error events and ignores non-json noise", () => {
    const parsed = parseGrokJsonl(["not json", JSON.stringify({ type: "error", message: "auth expired" })].join("\n"))
    expect(parsed.error).toBe("auth expired")
    expect(parsed.finalResponse).toBe("")
  })

  test("accepts only an explicit successful terminal reason, including the legacy spelling", () => {
    for (const reason of ["end_turn", "EndTurn"]) {
      const parsed = parseGrokJsonl(JSON.stringify({ type: "end", stopReason: reason, text: "answer" }))
      expect(parsed.completed).toBe(true)
      expect(parsed.stopReason).toBe("end_turn")
      expect(parsed.error).toBeUndefined()
      expect(parsed.finalResponse).toBe("answer")
    }
  })

  test("cancelled, limited, refused, unknown and missing terminal reasons are not completed turns", () => {
    for (const reason of [
      "cancelled",
      "max_tokens",
      "MaxTokens",
      "max_turn_requests",
      "refusal",
      "unknown",
      undefined,
    ]) {
      const parsed = parseGrokJsonl(
        [
          JSON.stringify({ type: "text", data: "partial answer" }),
          JSON.stringify({ type: "end", stopReason: reason, sessionId: "fixture" }),
        ].join("\n"),
      )
      expect(parsed.completed).toBe(false)
      expect(parsed.error).toContain("Grok Build stopped:")
      expect(parsed.transcript.at(-1)?.title).toBe("Turn failed")
      expect(parsed.transcript.find((item) => item.kind === "message")?.status).toBe("error")
    }
  })

  test("a partial answer and an error cannot bypass turn or process failure", () => {
    const events = [
      { type: "text", data: "partial answer" },
      { type: "error", message: "Authentication failed" },
      { type: "end", stopReason: "end_turn" },
    ]
    const parsed = parseGrokJsonl(events.map((event) => JSON.stringify(event)).join("\n"))
    expect(parsed.completed).toBe(false)
    expect(
      externalTurnFailure({ advisor: "Grok", exitCode: 0, answer: parsed.finalResponse, stderr: "", ...parsed }),
    ).toContain("Authentication failed")
    expect(
      externalTurnFailure({ advisor: "Grok", exitCode: 1, answer: "answer", stderr: "", completed: true }),
    ).toContain("exit 1")
  })

  test("a stream ending without a terminal event is incomplete, never raw JSON output", () => {
    const parsed = parseGrokJsonl(JSON.stringify({ type: "text", data: "unfinished" }))
    expect(parsed.completed).toBe(false)
    expect(parsed.transcript.find((item) => item.kind === "message")?.status).toBe("error")
    expect(
      externalTurnFailure({ advisor: "Grok", exitCode: 0, answer: parsed.finalResponse, stderr: "", ...parsed }),
    ).toContain("terminal event")
    const errorOnly = parseGrokJsonl(JSON.stringify({ type: "error", message: "Network failed" }))
    expect(errorOnly.finalResponse).toBe("")
    expect(errorOnly.completed).toBe(false)
  })

  test("a max_turns_reached event remains a failure even if an end_turn follows", () => {
    const state = createGrokLiveState()
    applyGrokJsonlLine(state, JSON.stringify({ type: "max_turns_reached" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "end", stopReason: "end_turn" }))
    expect(state.completed).toBe(false)
    expect(state.error).toContain("max_turn_requests")
  })

  test("resumed turns clear terminal state and diagnostics without forgetting the native session", () => {
    const state = createGrokLiveState()
    applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "old answer" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "end", stopReason: "cancelled", sessionId: "fixture" }))
    beginGrokTurn(state)
    expect(state.completed).toBe(false)
    expect(state.stopReason).toBeUndefined()
    expect(state.error).toBeUndefined()
    expect(state.preview).toBeUndefined()
    expect(state.assistantText).toBe("")
    expect(state.sessionId).toBe("fixture")
    applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "recovered" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "fixture" }))
    expect(state.completed).toBe(true)
    expect(state.assistantText).toBe("recovered")
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
