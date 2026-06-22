import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"

import { resolveDesktopPath, tempMarkdownAttachmentPath } from "./native-path"

describe("native desktop paths", () => {
  test("expands home aliases before resolving paths", () => {
    expect(resolveDesktopPath("~")).toBe(resolve(homedir()))
    expect(resolveDesktopPath("~/")).toBe(resolve(homedir()))
    expect(resolveDesktopPath("~/Documents")).toBe(resolve(homedir(), "Documents"))
    expect(resolveDesktopPath("~\\Documents")).toBe(resolve(homedir(), "Documents"))
  })

  test("leaves normal paths on the standard resolver path", () => {
    expect(resolveDesktopPath("/tmp/example")).toBe(resolve("/tmp/example"))
    expect(resolveDesktopPath("relative/example")).toBe(resolve("relative/example"))
    expect(resolveDesktopPath(join("/tmp", "space dir"))).toBe(resolve("/tmp", "space dir"))
  })

  test("builds project-scoped temporary markdown attachment paths", () => {
    const root = join("/tmp", "opencode-md-attachment")
    const path = tempMarkdownAttachmentPath(root, {
      id: "abcdef12",
      now: new Date("2026-06-22T09:30:15.123Z"),
    })

    expect(path.startsWith(join(root, ".opencode", "tmp", "attachments"))).toBe(true)
    expect(path.endsWith(join(".opencode", "tmp", "attachments", "prompt-2026-06-22T09-30-15-123Z-abcdef12.md"))).toBe(
      true,
    )
  })
})
