import { describe, expect, test } from "bun:test"
import { directoryBrowsePath, displayToAbsolute, withDirectoryTrailing } from "@/components/dialog-select-directory"
import { filterHomeDirectoryEntries, moveHomeDirectoryHighlight } from "./home-path-input"

describe("home path input", () => {
  const entries = [
    { name: "apps", path: "/Users/test/apps" },
    { name: "Archive", path: "/Users/test/Archive" },
    { name: "Documents", path: "/Users/test/Documents" },
  ]

  test("filters directory completions by the current path leaf", () => {
    expect(filterHomeDirectoryEntries(entries, "~/a")).toEqual([entries[0], entries[1]])
    expect(filterHomeDirectoryEntries(entries, "~/doc")).toEqual([entries[2]])
  })

  test("resolves tilde paths and keeps completed directories browsable", () => {
    expect(directoryBrowsePath("~/apps/opencode")).toBe("~/apps/")
    expect(displayToAbsolute("~/apps/opencode", "/Users/test", "/Users/test")).toBe("/Users/test/apps/opencode")
    expect(withDirectoryTrailing("~/apps")).toBe("~/apps/")
  })

  test("moves keyboard highlight without leaving the available options", () => {
    expect(moveHomeDirectoryHighlight(4, 8, "ArrowDown", false)).toBe(0)
    expect(moveHomeDirectoryHighlight(4, 8, "ArrowUp", false)).toBe(7)
    expect(moveHomeDirectoryHighlight(2, 8, "ArrowDown", true)).toBe(3)
    expect(moveHomeDirectoryHighlight(2, 8, "ArrowUp", true)).toBe(1)
    expect(moveHomeDirectoryHighlight(7, 8, "ArrowDown", true)).toBe(7)
    expect(moveHomeDirectoryHighlight(0, 8, "ArrowUp", true)).toBe(0)
    expect(moveHomeDirectoryHighlight(0, 0, "ArrowDown", true)).toBe(0)
  })
})
