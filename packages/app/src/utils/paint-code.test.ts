import { describe, expect, test } from "bun:test"
import { paintCode } from "./paint-code"

describe("paintCode", () => {
  test("highlights JSON strings, numbers, and primitives", () => {
    const html = paintCode('{"a": 1, "b": true, "c": null}')
    expect(html).toContain("var(--syntax-string)")
    expect(html).toContain("var(--syntax-constant)")
    expect(html).toContain("var(--syntax-primitive)")
    expect(html).toContain("var(--syntax-punctuation)")
    expect(html).toContain("&quot;a&quot;")
  })

  test("escapes raw HTML in source", () => {
    const html = paintCode('"<script>"')
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })

  test("returns non-breaking space for empty input", () => {
    expect(paintCode("")).toBe("&nbsp;")
  })
})
