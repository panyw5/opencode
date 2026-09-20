import { describe, expect, test } from "bun:test"
import { parseDelimitedText, tableDelimiter } from "./file-preview-model"

describe("file preview model", () => {
  test("parses quoted CSV fields, escaped quotes, and CRLF rows", () => {
    expect(parseDelimitedText('name,note\r\nAda,"uses, commas"\r\nLin,"said ""hello"""').rows).toEqual([
      ["name", "note"],
      ["Ada", "uses, commas"],
      ["Lin", 'said "hello"'],
    ])
  })

  test("detects tab-separated text", () => {
    expect(tableDelimiter("name\tvalue\nAda\t42")).toBe("\t")
    expect(parseDelimitedText("name\tvalue\nAda\t42").rows).toEqual([
      ["name", "value"],
      ["Ada", "42"],
    ])
  })

  test("bounds large tables", () => {
    const result = parseDelimitedText(Array.from({ length: 1_005 }, (_, index) => String(index)).join("\n"))
    expect(result.rows).toHaveLength(1_000)
    expect(result.truncated).toBe(true)
  })
})
