import { describe, expect, test } from "bun:test"
import {
  backdropInlineValue,
  calibratedBudgetMs,
  expectedConditionBlur,
  summarizeFrameWindow,
  summarizeIntervals,
  traceSummary,
} from "./benchmark-quick-assistant-scroll"

describe("summarizeIntervals", () => {
  test("uses sorted samples and reports the frame-budget exceedance rates", () => {
    expect(summarizeIntervals([18, 8, 17, 10, 13], 8.33)).toEqual({
      frames: 5,
      p50: 13,
      p95: 17,
      p99: 17,
      max: 18,
      over1_5BudgetPct: 60,
      over2BudgetPct: 40,
    })
  })

  test("returns zero-valued metrics when no in-window frames remain", () => {
    expect(summarizeIntervals([], 8.33)).toEqual({
      frames: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      over1_5BudgetPct: 0,
      over2BudgetPct: 0,
    })
  })

  test("calibrates frame budget from idle rAF and preserves the true baseline blur", () => {
    expect(calibratedBudgetMs({ p50Ms: 8.31, samples: 120 })).toBe(8.31)
    expect(() => calibratedBudgetMs({ p50Ms: 8.31, samples: 10 })).toThrow("Idle rAF calibration is not reliable")
    expect(backdropInlineValue("baseline", "blur(40px) saturate(150%)")).toBe("blur(40px) saturate(150%)")
    expect(backdropInlineValue("blur-disabled", "blur(40px) saturate(150%)")).toBe("none")
    expect(expectedConditionBlur("baseline", "blur(40px) saturate(1.5)")).toBe("blur(40px) saturate(1.5)")
    expect(expectedConditionBlur("blur-disabled", "blur(40px) saturate(1.5)")).toBe("none")
  })

  test("drops time-edge and scroll-boundary intervals from frame samples", () => {
    const frames = [
      { from: 190, to: 205, ms: 15, scrollTop: 500 },
      { from: 205, to: 220, ms: 15, scrollTop: 50 },
      { from: 220, to: 235, ms: 15, scrollTop: 500 },
      { from: 380, to: 395, ms: 15, scrollTop: 990 },
      { from: 395, to: 410, ms: 15, scrollTop: 500 },
    ]
    const result = summarizeFrameWindow(frames, 8.33, 100, 500, 1000, 100)
    expect(result.inTimeFrames).toBe(3)
    expect(result.excludedEdgeFrames).toBe(2)
    expect(result.summary.frames).toBe(1)
    expect(result.frames[0].scrollTop).toBe(500)
  })

  test("extracts ScrollJank and dropped-frame flags only inside the trace wheel window", () => {
    const trace = {
      traceEvents: [
        { ph: "M", name: "thread_name", pid: 1, tid: 10, args: { name: "CrRendererMain" } },
        { ph: "X", name: "EventDispatch", pid: 1, tid: 10, ts: 100, dur: 1, args: { data: { type: "wheel" } } },
        { ph: "X", name: "EventDispatch", pid: 1, tid: 10, ts: 1000, dur: 1, args: { data: { type: "wheel" } } },
        {
          ph: "b",
          name: "FrameSequenceTrackerV3",
          pid: 1,
          tid: 11,
          ts: 50,
          args: { args: { data: { expected: 999, dropped_v4: 999 } }, name: "WheelScroll" },
        },
        {
          ph: "b",
          name: "FrameSequenceTrackerV3",
          pid: 1,
          tid: 11,
          ts: 300,
          args: {
            args: { data: { expected: 10, dropped_v3: 1, dropped_v4: 2, missing_content: 0, checkerboarded: 0 } },
            name: "WheelScroll",
          },
        },
        {
          ph: "b",
          name: "ScrollJankV4",
          pid: 1,
          tid: 11,
          ts: 350,
          args: { scroll_jank_v4: { is_janky: true, damage_type: "DAMAGING", vsync_interval_us: 8333 } },
        },
        { ph: "b", name: "ScrollJankV4", pid: 1, tid: 11, ts: 50, args: { scroll_jank_v4: { is_janky: false } } },
      ],
    }
    const result = traceSummary(trace, 8.33)
    expect(result.traceWheelWindowUs).toMatchObject({ start: 100, end: 1001, wheelEvents: 2 })
    expect(result.frameSequence).toMatchObject({
      verified: false,
      rawBeginEvents: [
        { name: "WheelScroll", rawCounters: { expected: 10, dropped_v3: 1, dropped_v4: 2 }, matchedEnd: false },
      ],
    })
    expect(result.scrollJankV4).toMatchObject({ events: 1, janky: 1, notJanky: 0 })
  })
})
