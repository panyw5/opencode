import { describe, expect, test } from "bun:test"
import {
  Path,
  directoryEquals,
  isWindowsDrivePath,
  isWindowsUNCPath,
  pathIdentityKey,
  toLogicalPath,
  type PathContext,
} from "@opencode-ai/core/util/path"

const windowsLocal: PathContext = { platform: "win32", kind: "local-filesystem" }
const windowsRemote: PathContext = { platform: "win32", kind: "remote-filesystem" }
const windowsUrl: PathContext = { platform: "win32", kind: "url" }
const linuxLocal: PathContext = { platform: "linux", kind: "local-filesystem" }
const darwinLocal: PathContext = { platform: "darwin", kind: "local-filesystem" }

describe("context-aware path identity", () => {
  test("folds Windows local drive and UNC variants only", () => {
    const drives = ["D:/chat", "d:/chat", "D:\\chat", "D:\\chat\\"]
    expect(new Set(drives.map((value) => String(Path.identity(value, windowsLocal)))).size).toBe(1)
    expect(Path.equals("D:/chat", "d:/chat", windowsLocal)).toBe(true)
    expect(String(Path.identity("D:/chat", windowsRemote))).toBe("D:/chat")
    expect(Path.equals("D:/chat", "d:/chat", windowsRemote)).toBe(false)

    const unc = ["\\\\server\\share\\repo", "//server/share/repo"]
    expect(new Set(unc.map((value) => String(Path.identity(value, windowsLocal)))).size).toBe(1)
    expect(String(Path.identity("\\\\SERVER\\SHARE\\Repo", windowsRemote))).toBe("//SERVER/SHARE/Repo")
    expect(String(Path.identity("D:/", windowsLocal))).toBe("d:/")
    expect(String(Path.identity("D:\\", windowsLocal))).toBe("d:/")
  })

  test("does not fold POSIX case or treat backslash as a separator", () => {
    expect(String(Path.logical("foo\\bar", linuxLocal))).toBe("foo\\bar")
    expect(String(Path.logical("foo\\bar", darwinLocal))).toBe("foo\\bar")
    expect(Path.equals("/Users/A/project", "/Users/a/project", linuxLocal)).toBe(false)
    expect(Path.equals("/Volumes/Data/repo", "/Volumes/data/repo", darwinLocal)).toBe(false)
  })

  test("does not fold non-absolute Windows-looking values", () => {
    expect(String(Path.identity("foo\\bar", windowsLocal))).toBe("foo/bar")
    expect(String(Path.identity("D:relative", windowsLocal))).toBe("D:relative")
    expect(String(Path.identity("file:///C:/Repo/File.ts", windowsLocal))).toBe("c:/repo/file.ts")
    expect(String(Path.identity("file:///C:/Repo/File.ts", windowsRemote))).toBe("file:///C:/Repo/File.ts")
    expect(String(Path.identity("ssh://host/home/User/repo", windowsUrl))).toBe("ssh://host/home/User/repo")
    expect(String(Path.identity("/openclaw", windowsLocal))).toBe("/openclaw")
  })

  test("keeps legacy helpers compatible", () => {
    expect(toLogicalPath("D:\\chat\\")).toBe("D:/chat")
    expect(pathIdentityKey("D:\\Chat")).toBe("d:/chat")
    expect(pathIdentityKey("/tmp/foo\\bar/")).toBe("/tmp/foo\\bar")
    expect(directoryEquals("D:\\chat", "d:/chat/")).toBe(true)
  })
})

describe("path boundaries and routes", () => {
  test("checks segment boundaries and resolves dot traversal", () => {
    expect(Path.isInside("C:/repo", "c:/repo/src/file.ts", windowsLocal)).toBe(true)
    expect(Path.isInside("C:/repo", "file:///C:/repo/src/file.ts", windowsLocal)).toBe(true)
    expect(Path.equals("C:/Repo/File.ts", "file:///c:/repo/file.ts", windowsLocal)).toBe(true)
    expect(Path.isInside("C:/repo", "C:/repo2/file.ts", windowsLocal)).toBe(false)
    expect(Path.isInside("C:/repo", "C:/repo/../outside.ts", windowsLocal)).toBe(false)
    expect(String(Path.relative("C:/repo", "c:/repo/src/file.ts", windowsLocal))).toBe("src/file.ts")
    expect(String(Path.relative("C:/repo", "file:///C:/repo/src/file.ts", windowsLocal))).toBe("src/file.ts")
    expect(String(Path.relative("/repo", "/repo2/file.ts", linuxLocal))).toBe("../repo2/file.ts")
  })

  test("converts filesystem paths to native separators at the boundary", () => {
    expect(String(Path.native("D:/repo/file.ts", windowsLocal))).toBe("D:\\repo\\file.ts")
    expect(String(Path.native("file:///C:/repo/file.ts", windowsLocal))).toBe("C:\\repo\\file.ts")
    expect(String(Path.native("foo\\bar", linuxLocal))).toBe("foo\\bar")
  })

  test("round-trips URL-safe route slugs without turning them into paths", () => {
    const value = "D:\\Repo\\File.ts"
    const slug = Path.route.encode(value)
    expect(slug).not.toContain("/")
    expect(String(Path.route.decode(slug))).toBe(value)
    expect(String(Path.route.decode(Path.route.encode("/Users/A/project")))).toBe("/Users/A/project")
  })

  test("recognizes only absolute drive and UNC paths", () => {
    expect(isWindowsDrivePath("C:/repo")).toBe(true)
    expect(isWindowsDrivePath("C:repo")).toBe(false)
    expect(isWindowsUNCPath("\\\\server\\share\\repo")).toBe(true)
    expect(isWindowsUNCPath("//server")).toBe(false)
  })
})
