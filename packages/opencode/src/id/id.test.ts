import { describe, expect, test } from "bun:test"
import { create, timestamp } from "./id"

describe("identifier time encoding", () => {
  test("keeps ids sortable across the 48-bit wrap", () => {
    const wrap = 0x1a000000000
    const before = create("message", "ascending", wrap - 1)
    const after = create("message", "ascending", wrap + 1)

    expect(before < after).toBe(true)
    expect(timestamp(before)).toBe(wrap - 1)
    expect(timestamp(after)).toBe(wrap + 1)
  })

  test("orders ids created in the same millisecond by counter", () => {
    const now = 1_786_759_901_110
    const first = create("message", "ascending", now)
    const second = create("message", "ascending", now)
    expect(first < second).toBe(true)
    expect(timestamp(first)).toBe(now)
    expect(timestamp(second)).toBe(now)
  })

  test("decodes a 64-bit id produced by create()", () => {
    const id = create("tool", "ascending", 1_786_759_901_110)
    expect(timestamp(id)).toBe(1_786_759_901_110)
  })

  test("falls back to the 48-bit prefix for legacy ids", () => {
    expect(timestamp("tool_feaeca33f001ZZZZZZZZZZZZ")).toBe(Number(BigInt("0xfeaeca33f001") / BigInt(0x1000)))
  })
})
