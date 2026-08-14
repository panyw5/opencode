import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import {
  buildDshExecArgs,
  buildDshFollowupArgs,
  classifyDshFailure,
  formatDshHistory,
  normalizePatchSources,
  Parameters,
  resolveProfile,
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

  test("buildDshExecArgs applies a custom profile and patches in order", () => {
    const args = buildDshExecArgs({
      prompt: "Review auth flow",
      profile: "review",
      patch: ["/tmp/p1.yml", "/tmp/p2.yml"],
    })
    expect(args[0]).toBe("--profile")
    expect(args[1]).toBe("review")
    expect(args[2]).toBe("--patch")
    expect(args[3]).toBe("/tmp/p1.yml")
    expect(args[4]).toBe("--patch")
    expect(args[5]).toBe("/tmp/p2.yml")
    expect(args[6]).toContain("Review auth flow")
  })

  test("buildDshFollowupArgs replays prior turns into a fresh headless prompt", () => {
    const args = buildDshFollowupArgs({
      history: [
        { role: "user", text: "Review auth" },
        { role: "assistant", text: "Use short-lived tokens." },
      ],
      followup: "What about refresh tokens?",
    })
    expect(args[0]).toBe("--profile")
    expect(args[1]).toBe("headless")
    expect(args[2]).toContain("Prior consultation transcript:")
    expect(args[2]).toContain("User:\nReview auth")
    expect(args[2]).toContain("Advisor:\nUse short-lived tokens.")
    expect(args[2]).toContain("New user message:")
    expect(args[2]).toContain("What about refresh tokens?")
  })

  test("buildDshFollowupArgs keeps the custom profile and patches across follow-ups", () => {
    const args = buildDshFollowupArgs({
      history: [{ role: "user", text: "Review auth" }],
      followup: "And refresh tokens?",
      profile: "review",
      patch: ["/tmp/p1.yml"],
    })
    expect(args[0]).toBe("--profile")
    expect(args[1]).toBe("review")
    expect(args[2]).toBe("--patch")
    expect(args[3]).toBe("/tmp/p1.yml")
    expect(args[4]).toContain("And refresh tokens?")
  })

  test("resolveProfile defaults to headless and trims", () => {
    expect(resolveProfile(undefined)).toBe("headless")
    expect(resolveProfile("")).toBe("headless")
    expect(resolveProfile("  ")).toBe("headless")
    expect(resolveProfile("custom")).toBe("custom")
    expect(resolveProfile("  custom  ")).toBe("custom")
  })

  test("resolveProfile rejects whitespace", () => {
    expect(() => resolveProfile("my profile")).toThrow(/whitespace/)
  })

  test("normalizePatchSources flattens string and list inputs", () => {
    expect(normalizePatchSources(undefined)).toEqual([])
    expect(normalizePatchSources("  - id: tools\n    config: {}\n")).toEqual(["- id: tools\n    config: {}"])
    expect(normalizePatchSources(["  a  ", "", "b", "  "])).toEqual(["a", "b"])
  })

  test("formatDshHistory truncates oversized transcripts from the front", () => {
    const huge = "x".repeat(30_000)
    const text = formatDshHistory([
      { role: "user", text: huge },
      { role: "assistant", text: "final answer" },
    ])
    expect(text).toContain("...(earlier turns truncated)...")
    expect(text).toContain("final answer")
    expect(text.length).toBeLessThan(30_000)
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

  test("accepts optional profile and single patch string", () => {
    const parsed = parse(Parameters, {
      prompt: "review",
      profile: "analysis",
      patch: "- id: llm-deepseek\n  config:\n    models:\n      - id: deepseek-v4-pro\n",
    })
    expect(parsed.profile).toBe("analysis")
    expect(parsed.patch).toContain("llm-deepseek")
  })

  test("accepts patch as a list", () => {
    const parsed = parse(Parameters, {
      prompt: "review",
      patch: ["a: 1", "b: 2"],
    })
    expect(parsed.patch).toEqual(["a: 1", "b: 2"])
  })

  test("rejects a profile with whitespace", () => {
    expect(accepts(Parameters, { prompt: "hi", profile: "bad profile" })).toBe(true)
    expect(() => resolveProfile(parse(Parameters, { prompt: "hi", profile: "bad profile" }).profile)).toThrow(
      /whitespace/,
    )
  })
})
