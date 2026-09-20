import { describe, expect, test } from "bun:test"
import { formatDateTimeLocal, parseDateTimeLocal } from "./time"

describe("datetime-local conversion", () => {
  test("formats an epoch timestamp using local wall-clock fields", () => {
    const value = new Date(2026, 6, 22, 9, 5, 42).getTime()
    const date = new Date(value)

    expect(formatDateTimeLocal(value)).toBe(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
    )
  })

  test("round-trips a datetime-local value in the local timezone", () => {
    const input = "2026-07-22T09:05"
    const value = parseDateTimeLocal(input)
    const date = new Date(value)

    expect(Number.isFinite(value)).toBe(true)
    expect(formatDateTimeLocal(value)).toBe(input)
    expect(date.getHours()).toBe(9)
    expect(date.getMinutes()).toBe(5)
  })

  test("formats and parses a datetime-local value in a selected timezone", () => {
    const input = "2026-07-22T09:05"
    const value = parseDateTimeLocal(input, "Asia/Shanghai")

    expect(formatDateTimeLocal(value, "Asia/Shanghai")).toBe(input)
    expect(new Date(value).toISOString()).toBe("2026-07-22T01:05:00.000Z")
  })
})
