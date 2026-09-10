import { describe, expect, test } from "bun:test"
import { ScheduledTaskRotation } from "@/scheduled-task/rotation"

const tokens = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

describe("ScheduledTaskRotation", () => {
  test("keeps a session below both limits", () => {
    expect(ScheduledTaskRotation.evaluate({ runs: 29, tokens: tokens(999_999) })).toEqual({
      rotate: false,
      reason: undefined,
      runs: 29,
      tokens: 999_999,
    })
  })

  test("rotates after 30 runs", () => {
    expect(ScheduledTaskRotation.evaluate({ runs: 30, tokens: tokens(1) }).reason).toBe("runs")
  })

  test("rotates at 1000000 accumulated tokens", () => {
    expect(ScheduledTaskRotation.evaluate({ runs: 1, tokens: tokens(1_000_000) }).reason).toBe("tokens")
  })
})
