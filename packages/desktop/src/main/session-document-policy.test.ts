import { describe, expect, test } from "bun:test"
import { documentName, isolatedHTML, pngSlices, validateDocument } from "./session-document-policy"

describe("session document policy", () => {
  test("only supports known formats and matching bounded content", () => {
    expect(validateDocument({ format: "markdown", name: "chat", markdown: "你好" }).markdown).toBe("你好")
    for (const input of [
      null,
      { format: "exe", name: "a" },
      { format: "pdf", name: "a" },
      { format: "markdown", name: "a", markdown: "x".repeat(8 * 1024 * 1024 + 1) },
      { format: "png", name: "a", html: "", theme: "system" },
      { format: "png", name: "a", html: "", width: 2401 },
      { format: "png", name: "a", html: "", width: NaN },
    ]) {
      expect(() => validateDocument(input)).toThrow()
    }
  })
  test("accepts large deduplicated fidelity HTML while retaining an explicit bound", () => {
    const long = `<style>.math{font-family:KaTeX}</style><div class='math'>${"x+y=z ".repeat(1_500_000)}</div>`
    expect(Buffer.byteLength(long)).toBeGreaterThan(8 * 1024 * 1024)
    expect(validateDocument({ format: "png", name: "math", html: long }).html).toBe(long)
    expect(() => validateDocument({ format: "png", name: "math", html: "x".repeat(32 * 1024 * 1024 + 1) })).toThrow("32 MiB")
  })
  test("only validates and retains the payload consumed by the selected exporter", () => {
    for (const format of ["png", "pdf"] as const) {
      expect(validateDocument({ format, name: "chat", html: "<p>ok</p>", markdown: "x".repeat(9 * 1024 * 1024) }).markdown).toBeUndefined()
    }
    expect(validateDocument({ format: "markdown", name: "chat", markdown: "ok", html: "<".repeat(200_001) }).html).toBeUndefined()
  })
  test("filename cannot supply traversal or an empty basename", () => {
    expect(documentName("../../bad\\name.png")).toBe("-..-bad-name.png")
    expect(documentName("...")).toBe("session")
  })
  test("security policy precedes untrusted HTML and denies active content and external resources", () => {
    const html = isolatedHTML(
      '<script>alert(1)</script><img src="file:///secret"><iframe src="https://evil.test"></iframe>',
      "dark",
    )
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"))
    for (const directive of [
      "script-src 'none'",
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "img-src data:",
      "frame-src 'none'",
    ])
      expect(html).toContain(directive)
    expect(html).toContain("color-scheme:dark")
  })
  test("slices cover every row exactly once and bound bitmap allocations", () => {
    expect(pngSlices(4096)).toEqual([{ y: 0, height: 4096 }])
    expect(pngSlices(8193)).toEqual([
      { y: 0, height: 4096 },
      { y: 4096, height: 4096 },
      { y: 8192, height: 1 },
    ])
    expect(pngSlices(10000).reduce((sum, slice) => sum + slice.height, 0)).toBe(10000)
    for (const height of [0, -1, NaN, Infinity, 200001]) expect(() => pngSlices(height)).toThrow()
  })
})
