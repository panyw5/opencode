import { describe, expect, test } from "bun:test"
import { ScheduledTaskSchedule } from "@/scheduled-task/schedule"

describe("ScheduledTaskSchedule", () => {
  test("computes one-time and fixed-interval schedules", () => {
    expect(ScheduledTaskSchedule.next({ kind: "at", at: 500 }, 1_000)).toBe(500)
    expect(ScheduledTaskSchedule.next({ kind: "every", interval: 60_000 }, 1_000)).toBe(61_000)
  })

  test("keeps fixed-interval schedules on their original grid", () => {
    expect(ScheduledTaskSchedule.nextAfterOccurrence({ kind: "every", interval: 1_000 }, 10_000, 12_500)).toBe(13_000)
  })

  test("accepts five-field cron expressions and applies timezone", () => {
    const next = ScheduledTaskSchedule.next(
      { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Seoul" },
      Date.parse("2026-07-21T00:01:00Z"),
    )
    expect(next).toBe(Date.parse("2026-07-22T00:00:00Z"))
  })

  test("rejects invalid cron expressions and timezones", () => {
    expect(() => ScheduledTaskSchedule.validate({ kind: "cron", expression: "not cron" })).toThrow()
    expect(() =>
      ScheduledTaskSchedule.validate({ kind: "cron", expression: "0 9 * * *", timezone: "Mars/Olympus" }),
    ).toThrow()
  })
})
