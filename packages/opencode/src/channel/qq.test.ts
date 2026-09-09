import { describe, expect, test } from "bun:test"
import { __test } from "./qq"

describe("qq OneBot helpers", () => {
  test("extracts text and removes CQ segments", () => {
    expect(
      __test.messageText({
        post_type: "message",
        message_type: "group",
        raw_message: "[CQ:at,qq=10001] 你好",
      }),
    ).toBe("你好")
  })

  test("supports structured OneBot messages", () => {
    expect(
      __test.messageText({
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: "请总结" } },
        ],
      }),
    ).toBe("请总结")
  })

  test("enforces group mention when configured", () => {
    expect(__test.mentionsBot({ self_id: 10001, raw_message: "[CQ:at,qq=10001] hi" })).toBe(true)
    expect(__test.mentionsBot({ self_id: 10001, raw_message: "hi" })).toBe(false)
  })

  test("deduplicates message ids", () => {
    const dedupe = __test.createDedupe(1)
    expect(dedupe.claim("a")).toBe(true)
    expect(dedupe.claim("a")).toBe(false)
    expect(dedupe.claim("b")).toBe(true)
    expect(dedupe.claim("a")).toBe(true)
  })
})
