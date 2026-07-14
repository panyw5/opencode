import { describe, expect, test } from "bun:test"
import {
  buildCodexExecArgs,
  parseCodexJsonl,
  resolveTimeoutMs,
  Parameters,
} from "../../src/tool/codex_consult"
import { Result, Schema } from "effect"
import { ToolJsonSchema } from "../../src/tool/json-schema"

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

describe("tool.codex_consult helpers", () => {
  test("buildCodexExecArgs forces read-only sandbox and non-interactive approvals", () => {
    const args = buildCodexExecArgs({
      prompt: "Review auth flow",
      workingDirectory: "/tmp/project",
      model: "gpt-5.4",
    })
    expect(args).toContain("exec")
    expect(args).toContain("--sandbox")
    expect(args).toContain("read-only")
    expect(args).toContain("--skip-git-repo-check")
    expect(args).toContain("-C")
    expect(args).toContain("/tmp/project")
    expect(args).toContain("--json")
    expect(args).toContain("-m")
    expect(args).toContain("gpt-5.4")
    expect(args).toContain('approval_policy="never"')
    const promptArg = args.at(-1)!
    expect(promptArg).toContain("Review auth flow")
    expect(promptArg).toContain("external advisor")
    expect(promptArg).toContain("read-only")
  })

  test("buildCodexExecArgs omits model flag when unset", () => {
    const args = buildCodexExecArgs({
      prompt: "hello",
      workingDirectory: "/repo",
    })
    expect(args).not.toContain("-m")
  })

  test("parseCodexJsonl extracts final agent message and usage", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thr_abc" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "1", type: "agent_message", text: "Draft answer" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "2", type: "agent_message", text: "Final answer" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 20,
          reasoning_output_tokens: 5,
        },
      }),
    ].join("\n")

    const parsed = parseCodexJsonl(stdout)
    expect(parsed.threadId).toBe("thr_abc")
    expect(parsed.finalResponse).toBe("Final answer")
    expect(parsed.agentMessages).toEqual(["Draft answer", "Final answer"])
    expect(parsed.usage).toEqual({
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    })
    expect(parsed.error).toBeUndefined()
  })

  test("parseCodexJsonl captures turn failure", () => {
    const stdout = [
      JSON.stringify({ type: "turn.failed", error: { message: "auth expired" } }),
    ].join("\n")
    const parsed = parseCodexJsonl(stdout)
    expect(parsed.error).toBe("auth expired")
    expect(parsed.finalResponse).toBe("")
  })

  test("parseCodexJsonl ignores non-json noise lines", () => {
    const stdout = ["not json", JSON.stringify({ type: "thread.started", thread_id: "t1" }), ""].join(
      "\n",
    )
    const parsed = parseCodexJsonl(stdout)
    expect(parsed.threadId).toBe("t1")
    expect(parsed.finalResponse).toBe("")
  })

  test("resolveTimeoutMs clamps bounds", () => {
    expect(resolveTimeoutMs(undefined)).toBe(10 * 60 * 1000)
    expect(resolveTimeoutMs(100)).toBe(30 * 1000)
    expect(resolveTimeoutMs(999999999)).toBe(30 * 60 * 1000)
    expect(resolveTimeoutMs(120_000)).toBe(120_000)
  })
})

describe("tool.codex_consult parameters", () => {
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
    expect(parse(Parameters, { prompt: "x", model: "m" }).model).toBe("m")
  })
})
