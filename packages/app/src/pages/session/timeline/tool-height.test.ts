import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import { COLLAPSED_TOOL_HEIGHT, estimateRowHeight, OPEN_TOOL_HEIGHT, PRESENT_FILE_DESKTOP_HEIGHT } from "./estimate"
import { estimateRegisteredToolHeight, registerToolHeightEstimator } from "./tool-height"

const toolPart = (tool: string): ToolPart =>
  ({
    id: "prt_tool",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool,
    state: {
      status: "completed",
      input: {},
      output: "ok",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as ToolPart

const lookup = (part: Part) => (_messageID: string, partID: string) => (partID === part.id ? part : undefined)

const row = (part: Part) => ({
  _tag: "AssistantPart",
  userMessageID: "m",
  group: { type: "part" as const, ref: { messageID: "msg_1", partID: part.id } },
})

const WIDTH = 1080
const base = { textLineHeight: 31.2, charWidth: 11.4 }
const disposers: Array<() => void> = []
const register = (...args: Parameters<typeof registerToolHeightEstimator>) => {
  disposers.push(registerToolHeightEstimator(...args))
}

afterEach(() => {
  for (const dispose of disposers.splice(0).toReversed()) dispose()
})

describe("registerToolHeightEstimator", () => {
  test("disposer removes a fresh estimator", () => {
    const part = toolPart("ext_fresh")
    const dispose = registerToolHeightEstimator("ext_fresh", () => 120)
    expect(estimateRegisteredToolHeight({ part, width: WIDTH, open: false })).toBe(120)
    dispose()
    expect(estimateRegisteredToolHeight({ part, width: WIDTH, open: false })).toBeUndefined()
  })

  test("disposer restores the previous estimator and ignores stale calls", () => {
    const part = toolPart("ext_restore")
    const disposeFirst = registerToolHeightEstimator("ext_restore", () => 100)
    const disposeSecond = registerToolHeightEstimator("ext_restore", () => 200)
    expect(estimateRegisteredToolHeight({ part, width: WIDTH, open: false })).toBe(200)
    disposeFirst()
    expect(estimateRegisteredToolHeight({ part, width: WIDTH, open: false })).toBe(200)
    disposeSecond()
    expect(estimateRegisteredToolHeight({ part, width: WIDTH, open: false })).toBe(100)
    disposeFirst()
    expect(estimateRegisteredToolHeight({ part, width: WIDTH, open: false })).toBeUndefined()
  })

  test("ignores undefined, non-finite and negative estimates", () => {
    const part = toolPart("ext_invalid")
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const dispose = registerToolHeightEstimator("ext_invalid", () => value)
      expect(estimateRegisteredToolHeight({ part, width: WIDTH, open: false })).toBeUndefined()
      dispose()
    }
  })

  test("a throwing estimator logs a string and falls back", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    register("ext_throw", () => {
      throw new Error("boom")
    })
    const part = toolPart("ext_throw")
    expect(estimateRowHeight(row(part), WIDTH, { ...base, parts: lookup(part) })).toBe(COLLAPSED_TOOL_HEIGHT)
    expect(warn).toHaveBeenCalledWith("[timeline] tool height estimator failed tool=ext_throw error=boom")
    warn.mockRestore()
  })
})

describe("estimateRowHeight with registered tool estimators", () => {
  test("uses the registered estimate and passes geometry and open state", () => {
    const calls: Array<{ width: number; viewportWidth?: number; open: boolean }> = []
    register("ext_tool", (input) => {
      calls.push({ width: input.width, viewportWidth: input.viewportWidth, open: input.open })
      return input.open ? 300 : 180
    })
    const part = toolPart("ext_tool")
    expect(estimateRowHeight(row(part), WIDTH, { ...base, parts: lookup(part), viewportWidth: 1440 })).toBe(180)
    expect(
      estimateRowHeight(row(part), WIDTH, { ...base, parts: lookup(part), toolDefaultOpen: () => true }),
    ).toBe(300)
    expect(calls).toEqual([
      { width: WIDTH, viewportWidth: 1440, open: false },
      { width: WIDTH, viewportWidth: undefined, open: true },
    ])
  })

  test("falls back to the defaults without a registered estimator", () => {
    const part = toolPart("ext_unregistered")
    expect(estimateRowHeight(row(part), WIDTH, { ...base, parts: lookup(part) })).toBe(COLLAPSED_TOOL_HEIGHT)
    expect(estimateRowHeight(row(part), WIDTH, { ...base, parts: lookup(part), toolDefaultOpen: () => true })).toBe(
      OPEN_TOOL_HEIGHT,
    )
  })

  test("built-in present_file geometry wins over a registered estimator", () => {
    register("present_file", () => 999)
    const part = toolPart("present_file")
    expect(estimateRowHeight(row(part), WIDTH, { ...base, parts: lookup(part) })).toBe(PRESENT_FILE_DESKTOP_HEIGHT)
  })
})
