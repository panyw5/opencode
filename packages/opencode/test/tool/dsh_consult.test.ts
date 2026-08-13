import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import {
  buildDshExecArgs,
  classifyDshFailure,
  Parameters,
  resolveTimeoutMs,
} from "../../src/tool/dsh_consult"

const parse = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema)(input)

const accepts = (schema: Schema.Decoder<unknown>, input: unknown): boolean =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(input))

describe("tool.dsh_consult helpers", () => {
  test("buildDshExecArgs uses headless profile and frames the prompt", () => {
    const args = buildDshExecArgs({ prompt: "Review auth flow" })
    expect(args[0]).toBe("--profile")
    expect(args[1]).toBe("headless")
    expect(args[2]).toContain("Review auth flow")
    expect(args[2]).toContain("external advisor")
    expect(args[2]).toContain("Consultation request:")
  })

  test("classifyDshFailure catches missing credentials even when exit is 0", () => {
    const err = classifyDshFailure({
      exitCode: 0,
      stdout: "",
      stderr:
        'dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"',
    })
    expect(err).toContain("no API credentials")
  })

  test("classifyDshFailure accepts successful stdout", () => {
    expect(
      classifyDshFailure({
        exitCode: 0,
        stdout: "hello from dsh\n",
        stderr: "",
      }),
    ).toBeUndefined()
  })

  test("classifyDshFailure reports non-zero exit", () => {
    expect(
      classifyDshFailure({
        exitCode: 1,
        stdout: "",
        stderr: "dsh: boom",
      }),
    ).toContain("exited with code 1")
  })

  test("resolveTimeoutMs clamps bounds", () => {
    expect(resolveTimeoutMs(undefined)).toBe(10 * 60 * 1000)
    expect(resolveTimeoutMs(100)).toBe(30 * 1000)
    expect(resolveTimeoutMs(999999999)).toBe(30 * 60 * 1000)
    expect(resolveTimeoutMs(120_000)).toBe(120_000)
  })
})

describe("tool.dsh_consult parameters", () => {
  test("requires prompt", () => {
    expect(accepts(Parameters, {})).toBe(false)
    expect(parse(Parameters, { prompt: "hi" })).toEqual({ prompt: "hi" })
  })

  test("accepts optional working_directory and timeout_ms", () => {
    expect(
      parse(Parameters, {
        prompt: "review",
        working_directory: "/tmp/project",
        timeout_ms: 60_000,
      }),
    ).toEqual({
      prompt: "review",
      working_directory: "/tmp/project",
      timeout_ms: 60_000,
    })
  })
})
