import { describe, expect, test } from "bun:test"
import { hasVisibleText, readPartText } from "./message-part-text"

describe("hasVisibleText", () => {
  test("treats zero-width-only text as empty", () => {
    expect(hasVisibleText("\u200B")).toBe(false)
    expect(hasVisibleText(" \u200B ")).toBe(false)
    expect(hasVisibleText("")).toBe(false)
    expect(hasVisibleText("hello")).toBe(true)
  })
})

describe("readPartText", () => {
  test("strips zero-width characters before trim", () => {
    expect(readPartText(undefined, { id: "p1", text: "\u200B" })).toBe("")
    expect(readPartText({ p1: "\u200Bhi\u200B" }, { id: "p1", text: "fallback" })).toBe("hi")
  })
})
