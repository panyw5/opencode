import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import {
  clearToolPartHydration,
  isToolPartHydrated,
  markToolPartHydrated,
  shouldDeferToolPart,
  toolHydrationKey,
} from "./deferred-tool-helpers"

const tool = (input: {
  id?: string
  tool?: string
  status?: ToolPart["state"]["status"]
}): ToolPart =>
  ({
    id: input.id ?? "part_1",
    type: "tool",
    tool: input.tool ?? "bash",
    sessionID: "ses_1",
    messageID: "msg_1",
    callID: "call_1",
    state:
      input.status === "pending"
        ? { status: "pending", input: {} }
        : input.status === "running"
          ? {
              status: "running",
              input: {},
              time: { start: 1 },
            }
          : {
              status: "completed",
              input: {},
              output: "ok",
              metadata: {},
              time: { start: 1, end: 2 },
            },
  }) as ToolPart

describe("shouldDeferToolPart", () => {
  test("defers collapsed completed tools", () => {
    expect(shouldDeferToolPart(tool({ status: "completed" }))).toBe(true)
  })

  test("does not defer running or pending tools", () => {
    expect(shouldDeferToolPart(tool({ status: "running" }))).toBe(false)
    expect(shouldDeferToolPart(tool({ status: "pending" }))).toBe(false)
  })

  test("does not defer tools that open by default", () => {
    expect(shouldDeferToolPart(tool({ status: "completed" }), true)).toBe(false)
  })

  test("does not defer non-tool parts", () => {
    expect(shouldDeferToolPart({ id: "t1", type: "text", text: "hi" } as never)).toBe(false)
  })
})

describe("tool hydration cache", () => {
  test("tracks hydrated keys per session", () => {
    clearToolPartHydration()
    const key = toolHydrationKey("ses_a", "part_1")
    expect(isToolPartHydrated(key)).toBe(false)
    markToolPartHydrated(key)
    expect(isToolPartHydrated(key)).toBe(true)
    clearToolPartHydration("ses_a")
    expect(isToolPartHydrated(key)).toBe(false)
  })
})
