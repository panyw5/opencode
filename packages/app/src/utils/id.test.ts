import { describe, expect, test } from "bun:test"
import { Identifier } from "./id"

describe("identifier time encoding", () => {
  test("writes a 64-bit time prefix so new ids stay 26 characters after the prefix", () => {
    const first = Identifier.ascending("message")
    const second = Identifier.ascending("message")
    expect(first.startsWith("msg_")).toBe(true)
    expect(second.startsWith("msg_")).toBe(true)
    expect(first.slice(4)).toHaveLength(26)
    expect(first.slice(4, 20)).toMatch(/^[0-9a-f]{16}$/)
    expect(first < second).toBe(true)
  })
})
