import { describe, expect, test } from "bun:test"
import {
  USER_MESSAGE_RAIL_PREVIEW_LIMIT,
  userMessageRailHeight,
  userMessageRailMarkWidth,
  userMessageRailPreview,
} from "./session-user-message-rail-model"

describe("userMessageRailMarkWidth", () => {
  test("keeps a compact barcode when idle", () => {
    expect(userMessageRailMarkWidth(0, undefined)).toBe(20)
    expect(userMessageRailMarkWidth(8, undefined)).toBe(20)
  })

  test("magnifies the hovered mark and tapers neighboring marks", () => {
    expect(userMessageRailMarkWidth(4, 4)).toBe(48)
    expect(userMessageRailMarkWidth(3, 4)).toBe(38)
    expect(userMessageRailMarkWidth(2, 4)).toBe(30)
    expect(userMessageRailMarkWidth(1, 4)).toBe(24)
    expect(userMessageRailMarkWidth(0, 4)).toBe(20)
  })
})

describe("userMessageRailHeight", () => {
  test("keeps short rails dense and caps long rails", () => {
    expect(userMessageRailHeight(0)).toBe(0)
    expect(userMessageRailHeight(4)).toBe(80)
    expect(userMessageRailHeight(6)).toBe(120)
    expect(userMessageRailHeight(100)).toBe(520)
  })
})

describe("userMessageRailPreview", () => {
  test("leaves short messages unchanged", () => {
    expect(userMessageRailPreview("short prompt")).toBe("short prompt")
  })

  test("bounds long prompts before rendering", () => {
    const preview = userMessageRailPreview("x".repeat(1_000))
    expect(preview).toHaveLength(USER_MESSAGE_RAIL_PREVIEW_LIMIT)
    expect(preview.endsWith("...")).toBe(true)
  })
})
