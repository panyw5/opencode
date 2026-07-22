import { describe, expect, test } from "bun:test"
import {
  cronstrueLocale,
  describeCronExpression,
  formatCronNextRun,
  normalizeCronExpression,
  nextCronRunAt,
} from "./cron-preview"

describe("cron-preview", () => {
  test("normalizes five-field expressions", () => {
    expect(normalizeCronExpression("0 9 * * 1-5")).toBe("0 0 9 * * 1-5")
    expect(normalizeCronExpression("0 0 9 * * *")).toBe("0 0 9 * * *")
  })

  test("returns next run for valid cron", () => {
    const next = nextCronRunAt("0 9 * * *", "UTC", Date.parse("2026-07-22T00:00:00.000Z"))
    expect(next).toBe(Date.parse("2026-07-22T09:00:00.000Z"))
  })

  test("returns NA for invalid cron", () => {
    expect(formatCronNextRun("not a cron")).toBe("NA")
    expect(formatCronNextRun("")).toBe("NA")
    expect(formatCronNextRun("0 9 * * *", "Mars/Olympus")).toBe("NA")
    expect(describeCronExpression("not a cron", "zh")).toBe("NA")
    expect(describeCronExpression("", "zh")).toBe("NA")
  })

  test("describes cron meaning in Chinese", () => {
    const text = describeCronExpression("0 9 * * 1-5", "zh")
    expect(text).not.toBe("NA")
    expect(text).toContain("09:00")
    expect(text).toMatch(/星期一|周一/)
  })

  test("describes cron meaning in English", () => {
    const text = describeCronExpression("0 9 * * 1-5", "en")
    expect(text).toBe("At 09:00, Monday through Friday")
  })

  test("maps app locales to cronstrue locales", () => {
    expect(cronstrueLocale("zh")).toBe("zh_CN")
    expect(cronstrueLocale("zht")).toBe("zh_TW")
    expect(cronstrueLocale("en")).toBe("en")
  })
})
