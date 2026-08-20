import { describe, expect, test } from "bun:test"
import { hasVisibleText, shouldDropAssistantTextPart, stripInvisibleEdges } from "../../src/util/visible-text"

describe("hasVisibleText", () => {
  test("rejects empty, whitespace, and zero-width stubs", () => {
    expect(hasVisibleText(undefined)).toBe(false)
    expect(hasVisibleText("")).toBe(false)
    expect(hasVisibleText("   \n\t")).toBe(false)
    expect(hasVisibleText("\u200B")).toBe(false)
    expect(hasVisibleText("\u200B\u200C\u200D\uFEFF")).toBe(false)
    expect(hasVisibleText(" \u200B ")).toBe(false)
  })

  test("accepts text with visible characters", () => {
    expect(hasVisibleText("hello")).toBe(true)
    expect(hasVisibleText("\u200Bhello")).toBe(true)
    expect(hasVisibleText(" a ")).toBe(true)
  })
})

describe("shouldDropAssistantTextPart", () => {
  test("keeps empty string for Anthropic signed-reasoning separators", () => {
    expect(shouldDropAssistantTextPart("")).toBe(false)
  })

  test("drops zero-width and whitespace-only stubs", () => {
    expect(shouldDropAssistantTextPart("\u200B")).toBe(true)
    expect(shouldDropAssistantTextPart(" \u200B\n")).toBe(true)
    expect(shouldDropAssistantTextPart("   ")).toBe(true)
  })

  test("keeps visible content", () => {
    expect(shouldDropAssistantTextPart("ok")).toBe(false)
    expect(shouldDropAssistantTextPart("\u200Bok")).toBe(false)
  })
})

describe("stripInvisibleEdges", () => {
  test("removes leading and trailing zero-width characters only", () => {
    expect(stripInvisibleEdges("\u200Bhello\u200B")).toBe("hello")
    expect(stripInvisibleEdges("\u200B\u200B")).toBe("")
    expect(stripInvisibleEdges("he\u200Bllo")).toBe("he\u200Bllo")
  })
})
