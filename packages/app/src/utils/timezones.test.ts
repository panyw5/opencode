import { describe, expect, test } from "bun:test"
import { timeZoneLabel } from "./timezones"

describe("time zone labels", () => {
  test("uses the requested locale for display names", () => {
    expect(timeZoneLabel("Asia/Shanghai", "zh-Hans")).toBe("中国标准时间")
    expect(timeZoneLabel("Asia/Shanghai", "en")).toBe("China Standard Time")
  })

  test("falls back to the identifier for invalid zones", () => {
    expect(timeZoneLabel("Invalid/Zone", "zh-Hans")).toBe("Invalid/Zone")
  })
})
