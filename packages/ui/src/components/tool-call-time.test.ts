import { describe, expect, test } from "bun:test"
import type { ToolState } from "@opencode-ai/sdk/v2"
import { formatToolCallTime, toolCallStartMs } from "./tool-call-time"

describe("toolCallStartMs", () => {
  test("ignores pending tools", () => {
    const state = { status: "pending", input: {}, raw: "" } satisfies ToolState
    expect(toolCallStartMs(state)).toBeUndefined()
  })

  test("uses start while running", () => {
    const state = {
      status: "running",
      input: {},
      time: { start: 1_750_000_000_000 },
    } satisfies ToolState
    expect(toolCallStartMs(state)).toBe(1_750_000_000_000)
  })

  test("uses start when completed", () => {
    const state = {
      status: "completed",
      input: {},
      output: "",
      title: "read",
      metadata: {},
      time: { start: 1_750_000_000_000, end: 1_750_000_000_420 },
    } satisfies ToolState
    expect(toolCallStartMs(state)).toBe(1_750_000_000_000)
  })

  test("uses start when errored", () => {
    const state = {
      status: "error",
      input: {},
      error: "fail",
      time: { start: 1_750_000_000_000, end: 1_750_000_000_800 },
    } satisfies ToolState
    expect(toolCallStartMs(state)).toBe(1_750_000_000_000)
  })

  test("ignores missing start", () => {
    const state = {
      status: "running",
      input: {},
      time: { start: 0 },
    } satisfies ToolState
    expect(toolCallStartMs(state)).toBeUndefined()
  })
})

describe("formatToolCallTime", () => {
  test("formats a short local-style clock in UTC", () => {
    const start = Date.UTC(2026, 7, 16, 14, 32, 5)
    expect(formatToolCallTime(start, "en-GB", "UTC")).toBe("14:32")
  })
})
