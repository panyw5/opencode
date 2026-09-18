import { describe, expect, test } from "bun:test"
import { ScheduledTaskRotation } from "@/scheduled-task/rotation"

describe("ScheduledTaskRotation", () => {
  test("keeps a session below both limits", () => {
    expect(ScheduledTaskRotation.evaluate({ runs: 29, tokens: 999_999 })).toEqual({
      rotate: false,
      reason: undefined,
      runs: 29,
      tokens: 999_999,
    })
  })

  test("rotates after 30 runs", () => {
    expect(ScheduledTaskRotation.evaluate({ runs: 30, tokens: 1 }).reason).toBe("runs")
  })

  test("rotates at 1000000 current context tokens", () => {
    expect(ScheduledTaskRotation.evaluate({ runs: 1, tokens: 1_000_000 }).reason).toBe("tokens")
  })
})
