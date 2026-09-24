import { describe, expect, test } from "bun:test"
import type { AssistantMessage, ReasoningPart } from "@opencode-ai/sdk/v2"
import { reasoningElapsedMs } from "./reasoning-time"

const part = (start: number, end?: number) => ({ time: { start, end } }) as ReasoningPart
const message = (completed?: number) => ({ time: { completed } }) as AssistantMessage

describe("reasoningElapsedMs", () => {
  test("counts a streaming reasoning part from its own start", () => {
    expect(reasoningElapsedMs(part(1_000), message(), 2_250)).toBe(1_250)
  })

  test("freezes at the reasoning part end even when the turn continues", () => {
    expect(reasoningElapsedMs(part(1_000, 1_230), message(), 9_000)).toBe(230)
  })

  test("uses the message completion when an interrupted part has no end", () => {
    expect(reasoningElapsedMs(part(1_000), message(1_750), 9_000)).toBe(750)
  })

  test("omits invalid timing instead of showing a negative duration", () => {
    expect(reasoningElapsedMs(part(2_000, 1_000), message(), 9_000)).toBeUndefined()
    expect(reasoningElapsedMs(part(Number.NaN), message(), 9_000)).toBeUndefined()
  })
})
