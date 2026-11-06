import { describe, expect, test } from "bun:test"
import { directoryInputValue, filterDirectoryEntries, moveDirectoryHighlight } from "./directory-completion"

describe("shared directory completion", () => {
  test("filters by the final path segment without discarding spaces or hidden directories", () => {
    const entries = [
      { name: ".agents", path: "/home/test/.agents" },
      { name: "Applications (Parallels)", path: "/home/test/Applications (Parallels)" },
      { name: "apps", path: "/home/test/apps" },
    ]
    expect(filterDirectoryEntries(entries, "~/.")).toEqual([entries[0]])
    expect(filterDirectoryEntries(entries, "~/APP")).toEqual([entries[1], entries[2]])
    expect(filterDirectoryEntries(entries, "~/Applications (")).toEqual([entries[1]])
    expect(filterDirectoryEntries(entries, "~/")).toEqual(entries)
    expect(filterDirectoryEntries(entries, "~/missing")).toEqual([])
  })

  test("absolute-only fields expand display paths and preserve an empty optional setting", () => {
    expect(directoryInputValue("", "/home/test", true)).toBe("")
    expect(directoryInputValue("~/apps/", "/home/test", true)).toBe("/home/test/apps")
    expect(directoryInputValue("/", "/home/test", true)).toBe("/")
    expect(directoryInputValue("~/apps/", "/home/test", false)).toBe("~/apps/")
    expect(directoryInputValue("~/apps/", "C:/Users/test", true)).toBe("C:/Users/test/apps")
    expect(directoryInputValue("C:/", "C:/Users/test", true)).toBe("C:/")
    expect(directoryInputValue("//server/share/", "C:/Users/test", true)).toBe("//server/share")
  })

  test("keyboard navigation remains inside the current completion results", () => {
    expect(moveDirectoryHighlight(0, 3, "ArrowUp", false)).toBe(2)
    expect(moveDirectoryHighlight(2, 3, "ArrowDown", false)).toBe(0)
    expect(moveDirectoryHighlight(0, 3, "ArrowUp", true)).toBe(0)
    expect(moveDirectoryHighlight(2, 3, "ArrowDown", true)).toBe(2)
    expect(moveDirectoryHighlight(2, 0, "ArrowDown", true)).toBe(0)
  })
})
