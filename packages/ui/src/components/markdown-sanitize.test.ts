import { describe, expect, test } from "bun:test"
import DOMPurify from "dompurify"
import { createMarkdownSanitizer } from "./markdown-sanitize"

describe("Markdown sanitizer", () => {
  test("reuses its configuration without inheriting global purifier mutations", () => {
    const sanitize = createMarkdownSanitizer(window)
    DOMPurify.setConfig({ ALLOWED_TAGS: [] })
    try {
      for (let i = 0; i < 3; i++) {
        const html = sanitize("<h2>Heading</h2><style>body{display:none}</style>")
        expect(html).toContain("<h2>Heading</h2>")
        expect(html).not.toContain("<script")
        expect(html).not.toContain("<style")
        expect(html).not.toContain("display:none")
      }
    } finally {
      DOMPurify.clearConfig()
    }
  })

  test("matches the previous HTML, math and SVG sanitization policy", () => {
    const sanitize = createMarkdownSanitizer(window)
    const legacy = DOMPurify(window)
    const config = {
      USE_PROFILES: { html: true, svg: true, mathMl: true },
      SANITIZE_NAMED_PROPS: true,
      FORBID_TAGS: ["style"],
      FORBID_CONTENTS: ["style", "script"],
    }
    // happy-dom does not implement DOMPurify's traversal fully; security assertions
    // run against real Chromium in the CDP regression, not this compatibility test.
    for (const source of [
      "<math><mi>x</mi></math>",
      '<svg><path d="M0 0"/></svg>',
      '<p id="location" data-source-line="3">ok</p>',
      '<a href="javascript:alert(1)">bad</a>',
    ]) {
      expect(sanitize(source)).toBe(legacy.sanitize(source, config))
    }
  })

  test("does not add hooks to a different DOMPurify instance", () => {
    const other = DOMPurify(window)
    const sanitize = createMarkdownSanitizer(window)
    expect(sanitize("<p>first</p>")).toBe("<p>first</p>")
    expect(other.sanitize("<style>p{color:red}</style><p>second</p>")).toContain("second")
    other.setConfig({ ALLOWED_TAGS: [] })
    expect(sanitize("<strong>third</strong>")).toBe("<strong>third</strong>")
  })
})
