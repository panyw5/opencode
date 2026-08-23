import { beforeEach, describe, expect, test } from "bun:test"
import type { Part, ToolPart } from "@opencode-ai/sdk/v2"
import {
  capRowEstimate,
  clampRowEstimate,
  COLLAPSED_TOOL_HEIGHT,
  estimateRowHeight,
  estimateTextLines,
  ERROR_CARD_MAX_HEIGHT,
  INJECTED_PROMPT_HEIGHT,
  MIN_ROW_ESTIMATE,
  OPEN_TOOL_HEIGHT,
  PREVIOUS_PART_SPACING,
  REASONING_PREVIEW_GAP,
  REASONING_PREVIEW_HEIGHT,
  rowRenderCost,
  TEXT_PART_MARGIN,
  TEXT_PART_META_HEIGHT,
  timelineTextMetrics,
  timelineEstimateWidth,
  trimRangeToBudget,
  TURN_GAP_HEIGHT,
} from "./estimate"

const textPart = (text: string): Part =>
  ({ id: "prt_text", sessionID: "ses_1", messageID: "msg_1", type: "text", text }) as Part

const toolPart = (overrides: { tool?: string; status?: ToolPart["state"]["status"]; id?: string } = {}): ToolPart =>
  ({
    id: overrides.id ?? "prt_tool",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_1",
    tool: overrides.tool ?? "read",
    state: {
      status: overrides.status ?? "completed",
      input: {},
      output: "ok",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }) as ToolPart

const lookup = (part: Part) => (_messageID: string, partID: string) => (partID === part.id ? part : undefined)

const WIDTH = 1080
const lineHeight = 31.2
const charWidth = 11.4
const base = { textLineHeight: lineHeight, charWidth }
const MIN_TEXT_WIDTH = 240
const TEXT_WIDTH_INSET = 48

describe("estimateRowHeight fixed-height rows", () => {
  test("TurnGap uses the h-6 constant", () => {
    expect(estimateRowHeight({ _tag: "TurnGap", userMessageID: "m" }, WIDTH, base)).toBe(TURN_GAP_HEIGHT)
    expect(TURN_GAP_HEIGHT).toBe(24)
  })

  test("TurnDivider and collapsed DiffSummary match measured heights", () => {
    expect(estimateRowHeight({ _tag: "TurnDivider", userMessageID: "m", label: "compaction" }, WIDTH, base)).toBe(40)
    expect(estimateRowHeight({ _tag: "DiffSummary", userMessageID: "m", diffs: [{ file: "a" }] }, WIDTH, base)).toBe(44)
  })

  test("Thinking and Retry use their calibrated constants without the min clamp", () => {
    expect(estimateRowHeight({ _tag: "Thinking", userMessageID: "m", phase: "thinking" }, WIDTH, base)).toBe(24)
    expect(estimateRowHeight({ _tag: "Retry", userMessageID: "m" }, WIDTH, base)).toBe(44)
  })

  test("unknown tags keep the legacy fallback", () => {
    expect(estimateRowHeight({ _tag: "Mystery" }, WIDTH, base)).toBe(60)
  })
})

describe("estimateRowHeight AssistantPart rows", () => {
  test("a collapsed completed tool estimates the collapsible box", () => {
    const part = toolPart()
    const height = estimateRowHeight(
      {
        _tag: "AssistantPart",
        userMessageID: "m",
        group: { type: "part", ref: { messageID: "msg_1", partID: part.id } },
      },
      WIDTH,
      { ...base, parts: lookup(part) },
    )
    expect(height).toBe(COLLAPSED_TOOL_HEIGHT)
    expect(COLLAPSED_TOOL_HEIGHT).toBe(50)
  })

  test("previousAssistantPart adds the pt-3 spacing", () => {
    const part = toolPart()
    const row = {
      _tag: "AssistantPart",
      userMessageID: "m",
      group: { type: "part" as const, ref: { messageID: "msg_1", partID: part.id } },
    }
    const height = estimateRowHeight({ ...row, previousAssistantPart: true }, WIDTH, {
      ...base,
      parts: lookup(part),
    })
    expect(height).toBe(COLLAPSED_TOOL_HEIGHT + PREVIOUS_PART_SPACING)
    expect(PREVIOUS_PART_SPACING).toBe(12)
  })

  test("a running tool stays collapsed while a default-open tool estimates the open baseline", () => {
    const running = toolPart({ status: "running" })
    const completed = toolPart({ tool: "bash" })
    const groupOf = (part: ToolPart) => ({
      _tag: "AssistantPart",
      userMessageID: "m",
      group: { type: "part" as const, ref: { messageID: "msg_1", partID: part.id } },
    })
    expect(estimateRowHeight(groupOf(running), WIDTH, { ...base, parts: lookup(running) })).toBe(
      COLLAPSED_TOOL_HEIGHT,
    )
    expect(
      estimateRowHeight(groupOf(completed), WIDTH, {
        ...base,
        parts: lookup(completed),
        toolDefaultOpen: () => true,
      }),
    ).toBe(OPEN_TOOL_HEIGHT)
  })

  test("an answered question estimates the collapsed tool box", () => {
    const question = toolPart({ tool: "question" })
    expect(
      estimateRowHeight(
        {
          _tag: "AssistantPart",
          userMessageID: "m",
          group: { type: "part", ref: { messageID: "msg_1", partID: question.id } },
        },
        WIDTH,
        { ...base, parts: lookup(question) },
      ),
    ).toBe(COLLAPSED_TOOL_HEIGHT)
  })

  test("a reasoning part estimates the collapsed collapsible", () => {
    const part = { id: "prt_r", type: "reasoning", text: "thinking…" } as unknown as Part
    expect(
      estimateRowHeight(
        {
          _tag: "AssistantPart",
          userMessageID: "m",
          group: { type: "part", ref: { messageID: "msg_1", partID: "prt_r" } },
        },
        WIDTH,
        { ...base, parts: lookup(part) },
      ),
    ).toBe(32)
  })

  test("a streaming reasoning part includes its fixed three-line preview", () => {
    const part = { id: "prt_r", type: "reasoning", text: "still thinking" } as unknown as Part
    expect(
      estimateRowHeight(
        {
          _tag: "AssistantPart",
          userMessageID: "m",
          group: { type: "part", ref: { messageID: "msg_1", partID: "prt_r" } },
        },
        WIDTH,
        { ...base, parts: lookup(part), reasoningStreaming: () => true },
      ),
    ).toBe(32 + REASONING_PREVIEW_GAP + REASONING_PREVIEW_HEIGHT)
  })

  test("a text part estimates margin plus wrapped lines", () => {
    const part = textPart("one line")
    expect(
      estimateRowHeight(
        {
          _tag: "AssistantPart",
          userMessageID: "m",
          group: { type: "part", ref: { messageID: "msg_1", partID: part.id } },
        },
        WIDTH,
        { ...base, parts: lookup(part) },
      ),
    ).toBe(TEXT_PART_MARGIN + lineHeight)
    expect(TEXT_PART_MARGIN).toBe(24)
  })

  test("the final assistant text reserves its copy and metadata row", () => {
    const part = textPart("one line")
    const row = {
      _tag: "AssistantPart",
      userMessageID: "m",
      group: { type: "part" as const, ref: { messageID: "msg_1", partID: part.id } },
    }
    const withoutMeta = estimateRowHeight(row, WIDTH, { ...base, parts: lookup(part) })
    const withMeta = estimateRowHeight(row, WIDTH, {
      ...base,
      parts: lookup(part),
      textPartHasMeta: () => true,
    })
    expect(withMeta - withoutMeta).toBe(TEXT_PART_META_HEIGHT)
  })

  test("a missing part falls back instead of estimating garbage", () => {
    expect(
      estimateRowHeight(
        {
          _tag: "AssistantPart",
          userMessageID: "m",
          group: { type: "part", ref: { messageID: "msg_1", partID: "gone" } },
        },
        WIDTH,
        base,
      ),
    ).toBe(60)
  })
})

describe("estimateRowHeight context groups", () => {
  const parts = new Map<string, Part>([
    ["prt_a", toolPart({ id: "prt_a" })],
    ["prt_b", toolPart({ id: "prt_b" })],
    ["prt_c", toolPart({ id: "prt_c", status: "running" })],
  ])
  const options = {
    ...base,
    parts: (_messageID: string, partID: string) => parts.get(partID),
  }
  const contextRow = (ids: string[], previous = false) => ({
    _tag: "AssistantPart",
    userMessageID: "m",
    previousAssistantPart: previous,
    group: {
      type: "context" as const,
      refs: ids.map((partID) => ({ messageID: "msg_1", partID })),
    },
  })

  test("stacks collapsed tools with the 12px content gap", () => {
    expect(estimateRowHeight(contextRow(["prt_a"]), WIDTH, options)).toBe(50)
    expect(estimateRowHeight(contextRow(["prt_a", "prt_b"]), WIDTH, options)).toBe(50 * 2 + 12)
    expect(estimateRowHeight(contextRow(["prt_a", "prt_b", "prt_a"]), WIDTH, options)).toBe(50 * 3 + 12 * 2)
  })

  test("adds the previous-part spacing and keeps running members collapsed", () => {
    expect(estimateRowHeight(contextRow(["prt_a"], true), WIDTH, options)).toBe(50 + PREVIOUS_PART_SPACING)
    expect(estimateRowHeight(contextRow(["prt_a", "prt_c"]), WIDTH, options)).toBe(50 * 2 + 12)
  })
})

describe("estimateRowHeight text-driven rows", () => {
  test("CommentStrip estimates the tallest comment card instead of the user message text", () => {
    const height = estimateRowHeight({ _tag: "CommentStrip", userMessageID: "m" }, WIDTH, {
      ...base,
      userMessageText: () => "unrelated user text ".repeat(100),
      commentStripTexts: () => ["short", "comment ".repeat(80)],
    })
    expect(height).toBeGreaterThan(lineHeight * 2)
    expect(height).toBeLessThan(800 * 3)
  })

  test("UserMessage estimates chrome plus wrapped message text", () => {
    const options = { ...base, userMessageText: (id: string) => (id === "m" ? "hello" : undefined) }
    const height = estimateRowHeight({ _tag: "UserMessage", userMessageID: "m" }, WIDTH, options)
    expect(height).toBeCloseTo(50 + lineHeight, 5)
  })

  test("UserMessage without an accessor still estimates one line", () => {
    expect(estimateRowHeight({ _tag: "UserMessage", userMessageID: "m" }, WIDTH, base)).toBeGreaterThan(50)
  })

  test("UserMessage reserves a fixed collapsed injected prompt instead of its full synthetic text", () => {
    const withoutPrompt = estimateRowHeight({ _tag: "UserMessage", userMessageID: "m" }, WIDTH, {
      ...base,
      userMessageText: () => "short request",
    })
    const withPrompt = estimateRowHeight({ _tag: "UserMessage", userMessageID: "m" }, WIDTH, {
      ...base,
      userMessageText: () => "short request",
      userMessageHasInjectedPrompt: () => true,
    })
    expect(withPrompt - withoutPrompt).toBeCloseTo(INJECTED_PROMPT_HEIGHT, 5)
  })

  test("Error estimates card chrome plus wrapped text", () => {
    expect(estimateRowHeight({ _tag: "Error", userMessageID: "m", text: "boom" }, WIDTH, base)).toBeCloseTo(
      44 + lineHeight,
      5,
    )
  })

  test("Error respects the real card max-height", () => {
    expect(estimateRowHeight({ _tag: "Error", text: "x\n".repeat(500) }, WIDTH, base)).toBe(
      ERROR_CARD_MAX_HEIGHT,
    )
  })
})

describe("estimateTextLines", () => {
  test("wraps long paragraphs by the available width", () => {
    // width 1080 - inset 48 = 1032 / 11.4 ≈ 90 chars per line
    expect(estimateTextLines("x".repeat(90), WIDTH, charWidth)).toBe(1)
    expect(estimateTextLines("x".repeat(91), WIDTH, charWidth)).toBe(2)
  })

  test("counts explicit newlines per paragraph", () => {
    expect(estimateTextLines("a\n\nb", WIDTH, charWidth)).toBe(3)
    expect(estimateTextLines("", WIDTH, charWidth)).toBe(1)
  })

  test("never assumes fewer than the minimum characters per line", () => {
    // width 100 floors to 240px content → 21 chars, but the floor is 24 → 2 lines.
    expect(estimateTextLines("x".repeat(40), 100, charWidth)).toBe(2)
    expect(estimateTextLines("x".repeat(25), 100, charWidth)).toBe(2)
    expect(estimateTextLines("x".repeat(24), 100, charWidth)).toBe(1)
  })

  test("narrow widths use the floor width", () => {
    expect(estimateTextLines("x".repeat(40), 0, charWidth)).toBe(
      estimateTextLines("x".repeat(40), MIN_TEXT_WIDTH + TEXT_WIDTH_INSET, charWidth),
    )
  })

  test("weights CJK glyphs so medium-width mixed text does not lose a wrapped line", () => {
    const text =
      "研究中的 API 结论可用，但它误把 notebook 后面的另一对低权 null 当成目标 seed。实际目标仍是 `:6008–6010` 的两条 $h=9/2$ 向量；后续实现会强制使用这两式，并仅采用 `OPEdefs.m`。"
    expect(estimateTextLines(text, 800, 11.4)).toBe(3)
    expect(estimateTextLines(text, 1120, 11.4)).toBe(2)
  })
})

describe("clampRowEstimate", () => {
  test("raises small rows to the minimum", () => {
    expect(clampRowEstimate(10, 800)).toBe(40)
  })

  test("caps huge rows at three viewports", () => {
    expect(clampRowEstimate(5000, 800)).toBe(2400)
  })

  test("keeps in-range estimates untouched", () => {
    expect(clampRowEstimate(120, 800)).toBe(120)
  })
})

describe("capRowEstimate", () => {
  test("keeps sub-minimum structural heights exact", () => {
    expect(capRowEstimate(24, 800)).toBe(24)
    expect(capRowEstimate(32, 800)).toBe(32)
  })

  test("still caps huge stacks at three viewports", () => {
    expect(capRowEstimate(6288, 800)).toBe(2400)
  })
})

describe("estimateRowHeight viewport clamp", () => {
  test("uses the default viewport before the list ResizeObserver reports a positive height", () => {
    const part = textPart("one line")
    const row = {
      _tag: "AssistantPart",
      userMessageID: "m",
      group: { type: "part" as const, ref: { messageID: "msg_1", partID: part.id } },
    }
    expect(
      estimateRowHeight(row, WIDTH, {
        ...base,
        parts: lookup(part),
        viewportHeight: 0,
      }),
    ).toBeGreaterThan(MIN_ROW_ESTIMATE)
  })

  test("clamps a very long text row to three viewports", () => {
    const part = textPart("word ".repeat(20000))
    expect(
      estimateRowHeight(
        {
          _tag: "AssistantPart",
          userMessageID: "m",
          group: { type: "part", ref: { messageID: "msg_1", partID: part.id } },
        },
        WIDTH,
        { ...base, parts: lookup(part), viewportHeight: 600 },
      ),
    ).toBe(1800)
  })
})

describe("rowRenderCost", () => {
  test("cheap structural rows cost far less than open tools", () => {
    expect(rowRenderCost({ _tag: "TurnGap" }, base)).toBe(0.25)
    expect(rowRenderCost({ _tag: "Thinking", userMessageID: "m", phase: "thinking" }, base)).toBe(0.25)
    expect(rowRenderCost({ _tag: "TurnDivider", userMessageID: "m", label: "compaction" }, base)).toBe(0.5)
    const collapsed = toolPart()
    const running = toolPart({ status: "running" })
    const groupOf = (part: ToolPart) => ({
      _tag: "AssistantPart",
      userMessageID: "m",
      group: { type: "part" as const, ref: { messageID: "msg_1", partID: part.id } },
    })
    expect(rowRenderCost(groupOf(collapsed), { ...base, parts: lookup(collapsed) })).toBe(1)
    expect(rowRenderCost(groupOf(running), { ...base, parts: lookup(running) })).toBe(6)
  })

  test("a context group costs one card per member", () => {
    const cost = rowRenderCost(
      {
        _tag: "AssistantPart",
        userMessageID: "m",
        group: {
          type: "context",
          refs: [
            { messageID: "msg_1", partID: "a" },
            { messageID: "msg_1", partID: "b" },
            { messageID: "msg_1", partID: "c" },
          ],
        },
      },
      base,
    )
    expect(cost).toBe(3.5)
  })

  test("text cost grows with wrapped lines but is capped", () => {
    const short = textPart("one line")
    const long = textPart("x".repeat(5000))
    const rowOf = (part: Part) => ({
      _tag: "AssistantPart",
      userMessageID: "m",
      group: { type: "part" as const, ref: { messageID: "msg_1", partID: part.id } },
    })
    const shortCost = rowRenderCost(rowOf(short), { ...base, parts: lookup(short) })
    const longCost = rowRenderCost(rowOf(long), { ...base, parts: lookup(long) })
    expect(shortCost).toBe(1)
    expect(longCost).toBeGreaterThan(shortCost)
    expect(longCost).toBeLessThanOrEqual(8)
  })
})

describe("trimRangeToBudget", () => {
  const costOf = (index: number) => (index % 3 === 0 ? 1 : 3)

  test("keeps the visible window regardless of budget", () => {
    const trimmed = trimRangeToBudget({
      indexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      startIndex: 4,
      endIndex: 6,
      costOf,
      budget: 0,
    })
    expect(trimmed).toEqual([4, 5, 6])
  })

  test("expands closest-first until the budget is spent", () => {
    const trimmed = trimRangeToBudget({
      indexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      startIndex: 4,
      endIndex: 5,
      costOf,
      budget: 6, // visible costs 3+3=6 → nothing left
    })
    expect(trimmed).toEqual([4, 5])

    const withSpare = trimRangeToBudget({
      indexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      startIndex: 4,
      endIndex: 5,
      costOf,
      budget: 7, // 1 spare → index 3 (cost 1) fits, index 2 (cost 3) does not
    })
    expect(withSpare).toEqual([3, 4, 5])
  })

  test("returns sorted unique indexes", () => {
    const trimmed = trimRangeToBudget({
      indexes: [9, 2, 4, 7, 4],
      startIndex: 4,
      endIndex: 4,
      costOf: () => 0.5,
      budget: 10,
    })
    expect(trimmed).toEqual([2, 4, 7, 9])
  })
})

describe("timelineTextMetrics", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme")
    document.documentElement.removeAttribute("style")
  })

  test("reads the claude theme metrics from the document", () => {
    document.documentElement.dataset.theme = "claude"
    document.documentElement.style.setProperty("--font-size-base", "18px")
    expect(timelineTextMetrics(undefined)).toEqual({ lineHeight: 19 * 1.65, charWidth: 19 * 0.6 })
  })

  test("reads the base theme metrics", () => {
    document.documentElement.style.setProperty("--font-size-base", "14px")
    expect(timelineTextMetrics(undefined)).toEqual({ lineHeight: 14 * 1.8, charWidth: 14 * 0.55 })
  })

  test("falls back to defaults without a readable font size", () => {
    expect(timelineTextMetrics(undefined)).toEqual({ lineHeight: 25.2, charWidth: 7.7 })
  })
})

describe("timelineEstimateWidth", () => {
  test("caps centered desktop rows to the configured content width", () => {
    expect(timelineEstimateWidth({ viewportWidth: 1663, centered: true, contentWidth: 350 })).toBe(1120)
  })

  test("uses the viewport for non-centered and mobile layouts", () => {
    expect(timelineEstimateWidth({ viewportWidth: 1663, centered: false, contentWidth: 350 })).toBe(1663)
    expect(timelineEstimateWidth({ viewportWidth: 700, centered: true, contentWidth: 350 })).toBe(700)
  })
})
