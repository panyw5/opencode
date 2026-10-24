import { describe, expect, test } from "bun:test"
import { createSessionContextFormatter } from "./session-context-format"

describe("createSessionContextFormatter", () => {
  test("formats numbers with group separators", () => {
    const formatter = createSessionContextFormatter("en-US")
    expect(formatter.number(148401)).toBe("148,401")
  })

  test("formats missing numbers as em dash", () => {
    const formatter = createSessionContextFormatter("en-US")
    expect(formatter.number(undefined)).toBe("—")
    expect(formatter.number(null)).toBe("—")
  })

  test("compacts large numbers", () => {
    const formatter = createSessionContextFormatter("en-US")
    expect(formatter.compact(1234567)).toBe("1.2M")
    expect(formatter.compact(890123)).toBe("890.1K")
  })

  test("compacts missing numbers as em dash", () => {
    const formatter = createSessionContextFormatter("en-US")
    expect(formatter.compact(undefined)).toBe("—")
    expect(formatter.compact(null)).toBe("—")
  })
})
