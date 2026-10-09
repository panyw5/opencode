import { describe, expect, test } from "bun:test"
import { filterAtFileSources, isLegacyGptProTransportPath } from "./gpt-pro-private-files"

describe("legacy GPT-Pro transport path filtering", () => {
  test("matches only the former workspace spool shape across path separators", () => {
    expect(isLegacyGptProTransportPath("/repo/.opencode/gpt-pro-a1b2c3/0/clipboard.png")).toBe(true)
    expect(isLegacyGptProTransportPath("repo\\.opencode\\gpt-pro-a1b2c3\\1\\notes.txt")).toBe(true)
    expect(isLegacyGptProTransportPath(".opencode/gpt-pro-A1b2C3")).toBe(true)
    expect(isLegacyGptProTransportPath(".opencode/gpt-pro-A1b2C3/0")).toBe(true)
  })

  test("preserves normal temp attachments, screenshots, source files, and unrelated names", () => {
    for (const path of [
      ".opencode/tmp/attachments/screenshot-123.png",
      ".opencode/tmp/attachments/prompt-123.md",
      ".opencode/gpt-pro-notes.md",
      ".opencode/gpt-pro-user-data/a.txt",
      "src/gpt-pro-a1b2c3/0/notes.txt",
      ".opencode/gpt-pro-a1b2c3-notes/0/notes.txt",
    ]) {
      expect(isLegacyGptProTransportPath(path)).toBe(false)
    }
  })

  test("filters both recent and search candidates without losing ordinary sources", () => {
    const result = filterAtFileSources(
      ["/repo/.opencode/gpt-pro-a1b2c3/0/image.png", "/repo/.opencode/tmp/attachments/screenshot-1.png"],
      [".opencode/gpt-pro-a1b2c3/1/notes.txt", "src/notes.txt"],
    )
    expect(result).toEqual({
      recent: ["/repo/.opencode/tmp/attachments/screenshot-1.png"],
      search: ["src/notes.txt"],
      excluded: 2,
    })
  })
})
