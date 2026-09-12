import { describe, expect, test } from "bun:test"
import { createPathHelpers, stripQueryAndHash, unquoteGitPath, encodeFilePath } from "./path"

describe("file path helpers", () => {
  test("normalizes file inputs against workspace root", () => {
    const path = createPathHelpers(() => "/repo")
    expect(path.normalize("file:///repo/src/app.ts?x=1#h")).toBe("src/app.ts")
    expect(path.normalize("/repo/src/app.ts")).toBe("src/app.ts")
    expect(path.normalize("./src/app.ts")).toBe("src/app.ts")
    expect(path.normalizeDir("src/components///")).toBe("src/components")
    expect(path.tab("src/app.ts")).toBe("file://src/app.ts")
    expect(path.pathFromTab("file://src/app.ts")).toBe("src/app.ts")
    expect(path.pathFromTab("other://src/app.ts")).toBeUndefined()
  })

  test("normalizes Windows absolute paths with mixed separators", () => {
    const path = createPathHelpers(() => "C:\\repo")
    // New logical contract: normalize() resolves to workspace-relative logical
    // paths with forward slashes. Native separators are only reconstructed at
    // filesystem/shell boundaries (Path.native), never in panel state.
    expect(path.normalize("C:\\repo\\src\\app.ts")).toBe("src/app.ts")
    expect(path.normalize("C:/repo/src/app.ts")).toBe("src/app.ts")
    expect(path.normalize("file://C:/repo/src/app.ts")).toBe("src/app.ts")
    expect(path.normalize("c:\\repo\\src\\app.ts")).toBe("src/app.ts")
  })

  test("keeps query/hash stripping behavior stable", () => {
    expect(stripQueryAndHash("a/b.ts#L12?x=1")).toBe("a/b.ts")
    expect(stripQueryAndHash("a/b.ts?x=1#L12")).toBe("a/b.ts")
    expect(stripQueryAndHash("a/b.ts")).toBe("a/b.ts")
  })

  test("unquotes git escaped octal path strings", () => {
    expect(unquoteGitPath('"a/\\303\\251.txt"')).toBe("a/\u00e9.txt")
    expect(unquoteGitPath('"plain\\nname"')).toBe("plain\nname")
    expect(unquoteGitPath("a/b/c.ts")).toBe("a/b/c.ts")
    // Direct multi-byte characters inside a quoted body are literal
    // characters, not bytes to charCode into a Uint8Array.
    expect(unquoteGitPath('"中文.txt"')).toBe("中文.txt")
    // Invalid escapes keep their backslash instead of naming another file.
    expect(unquoteGitPath('"a\\q.txt"')).toBe("a\\q.txt")
  })
})

describe("explicit source parsers (path contract)", () => {
  test("raw POSIX filenames keep #, ? and %20 verbatim", () => {
    const path = createPathHelpers(() => "/repo")
    expect(path.fromRaw("src/a#b.ts")).toBe("src/a#b.ts")
    expect(path.fromRaw("src/a?b.ts")).toBe("src/a?b.ts")
    expect(path.fromRaw("src/a%20b.ts")).toBe("src/a%20b.ts")
    expect(path.fromRaw('src/a"b.ts')).toBe('src/a"b.ts')
    expect(path.normalize("src/a#b.ts")).toBe("src/a#b.ts")
    expect(path.normalize("src/a%20b.ts")).toBe("src/a%20b.ts")
  })

  test("standard Windows file URL resolves to workspace-relative logical path", () => {
    const path = createPathHelpers(() => "C:\\repo")
    expect(path.fromFileUrl("file:///C:/repo/src/App.ts")).toBe("src/App.ts")
    expect(path.normalize("file:///C:/repo/src/App.ts")).toBe("src/App.ts")
    // Outside the workspace the absolute logical path is preserved verbatim.
    expect(path.fromFileUrl("file:///C:/repo2/src/App.ts")).toBe("C:/repo2/src/App.ts")
  })

  test("POSIX backslash filename round-trips through the internal tab", () => {
    const path = createPathHelpers(() => "/repo", () => ({ platform: "darwin", kind: "local-filesystem" }))
    const encoded = path.tab("src/a\\b.ts")
    expect(encoded).toBe(`file://src/${encodeURIComponent("a\\b.ts")}`)
    expect(path.pathFromTab(encoded)).toBe("src/a\\b.ts")
    // legacy default (no context) folds backslashes like the old encoder
    const legacy = createPathHelpers(() => "/repo")
    expect(legacy.tab("src/a\\b.ts")).toBe("file://src/a/b.ts")
  })

  test("tab decode happens once per segment and never re-decodes", () => {
    const path = createPathHelpers(() => "/repo")
    // A literal %20 in the filename encodes to %2520 and survives one decode.
    const encoded = path.tab("src/a%20b.ts")
    expect(encoded).toBe("file://src/a%2520b.ts")
    expect(path.pathFromTab(encoded)).toBe("src/a%20b.ts")
    // A literal %2F in the filename encodes to %252F (a real slash can never
    // be part of a filename, so an encoded one only comes from literal text).
    expect(path.pathFromTab("file://src/a%252Fb.ts")).toBe("src/a%2Fb.ts")
    // Query and hash belong to the tab, not the filename.
    expect(path.pathFromTab("file://src/app.ts?start=10&end=20")).toBe("src/app.ts")
  })

  test("git output is unquoted exactly once at the git boundary", () => {
    const path = createPathHelpers(() => "/repo")
    expect(path.fromGit('"a/\\303\\251.txt"')).toBe("a/é.txt")
    // Already-decoded paths are not quoted input and pass through unchanged.
    expect(path.fromGit("a/é.txt")).toBe("a/é.txt")
  })

  test("standard UNC file URLs keep the server/share root", () => {
    const path = createPathHelpers(() => "//server/share/repo")
    expect(path.fromFileUrl("file://server/share/repo/src/App.ts")).toBe("src/App.ts")
    // Internal tab form keeps the authority-looking first segment relative.
    expect(path.fromTab("file://server/share/repo/src/App.ts")).toBe("server/share/repo/src/App.ts")
  })

  test("POSIX absolute paths outside the workspace are not mangled", () => {
    const path = createPathHelpers(() => "/repo")
    expect(path.fromRaw("/repo2/file.ts")).toBe("/repo2/file.ts")
    expect(path.fromRaw("/repo/src/app.ts")).toBe("src/app.ts")
    expect(path.fromRaw("/repo/src/../outside.ts")).toBe("src/../outside.ts")
  })
})

describe("encodeFilePath", () => {
  describe("Linux/Unix paths", () => {
    test("should handle Linux absolute path", () => {
      const linuxPath = "/home/user/project/README.md"
      const result = encodeFilePath(linuxPath)
      const fileUrl = `file://${result}`

      // Should create a valid URL
      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/home/user/project/README.md")

      const url = new URL(fileUrl)
      expect(url.protocol).toBe("file:")
      expect(url.pathname).toBe("/home/user/project/README.md")
    })

    test("should handle Linux path with special characters", () => {
      const linuxPath = "/home/user/file#name with spaces.txt"
      const result = encodeFilePath(linuxPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/home/user/file%23name%20with%20spaces.txt")
    })

    test("should handle Linux relative path", () => {
      const relativePath = "src/components/App.tsx"
      const result = encodeFilePath(relativePath)

      expect(result).toBe("src/components/App.tsx")
    })

    test("should handle Linux root directory", () => {
      const result = encodeFilePath("/")
      expect(result).toBe("/")
    })

    test("should handle Linux path with all special chars", () => {
      const path = "/path/to/file#with?special%chars&more.txt"
      const result = encodeFilePath(path)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toContain("%23") // #
      expect(result).toContain("%3F") // ?
      expect(result).toContain("%25") // %
      expect(result).toContain("%26") // &
    })
  })

  describe("macOS paths", () => {
    test("should handle macOS absolute path", () => {
      const macPath = "/Users/kelvin/Projects/opencode/README.md"
      const result = encodeFilePath(macPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/Users/kelvin/Projects/opencode/README.md")
    })

    test("should handle macOS path with spaces", () => {
      const macPath = "/Users/kelvin/My Documents/file.txt"
      const result = encodeFilePath(macPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toContain("My%20Documents")
    })
  })

  describe("Windows paths", () => {
    test("should handle Windows absolute path with backslashes", () => {
      const windowsPath = "D:\\dev\\projects\\opencode\\README.bs.md"
      const result = encodeFilePath(windowsPath)
      const fileUrl = `file://${result}`

      // Should create a valid, parseable URL
      expect(() => new URL(fileUrl)).not.toThrow()

      const url = new URL(fileUrl)
      expect(url.protocol).toBe("file:")
      expect(url.pathname).toContain("README.bs.md")
      expect(result).toBe("/D:/dev/projects/opencode/README.bs.md")
    })

    test("should handle mixed separator path (Windows + Unix)", () => {
      // This is what happens in build-request-parts.ts when concatenating paths
      const mixedPath = "D:\\dev\\projects\\opencode/README.bs.md"
      const result = encodeFilePath(mixedPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/D:/dev/projects/opencode/README.bs.md")
    })

    test("should handle Windows path with spaces", () => {
      const windowsPath = "C:\\Program Files\\MyApp\\file with spaces.txt"
      const result = encodeFilePath(windowsPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toContain("Program%20Files")
      expect(result).toContain("file%20with%20spaces.txt")
    })

    test("should handle Windows path with special chars in filename", () => {
      const windowsPath = "D:\\projects\\file#name with ?marks.txt"
      const result = encodeFilePath(windowsPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toContain("file%23name%20with%20%3Fmarks.txt")
    })

    test("should handle Windows root directory", () => {
      const windowsPath = "C:\\"
      const result = encodeFilePath(windowsPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/C:/")
    })

    test("should handle Windows relative path with backslashes", () => {
      const windowsPath = "src\\components\\App.tsx"
      const result = encodeFilePath(windowsPath)

      // Relative paths shouldn't get the leading slash
      expect(result).toBe("src/components/App.tsx")
    })

    test("should NOT create invalid URL like the bug report", () => {
      // This is the exact scenario from bug report by @alexyaroshuk
      const windowsPath = "D:\\dev\\projects\\opencode\\README.bs.md"
      const result = encodeFilePath(windowsPath)
      const fileUrl = `file://${result}`

      // The bug was creating: file://D%3A%5Cdev%5Cprojects%5Copencode/README.bs.md
      expect(result).not.toContain("%5C") // Should not have encoded backslashes
      expect(result).not.toBe("D%3A%5Cdev%5Cprojects%5Copencode/README.bs.md")

      // Should be valid
      expect(() => new URL(fileUrl)).not.toThrow()
    })

    test("should handle lowercase drive letters", () => {
      const windowsPath = "c:\\users\\test\\file.txt"
      const result = encodeFilePath(windowsPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/c:/users/test/file.txt")
    })
  })

  describe("Cross-platform compatibility", () => {
    test("should preserve Unix paths unchanged (except encoding)", () => {
      const unixPath = "/usr/local/bin/app"
      const result = encodeFilePath(unixPath)
      expect(result).toBe("/usr/local/bin/app")
    })

    test("should normalize Windows paths for cross-platform use", () => {
      const windowsPath = "C:\\Users\\test\\file.txt"
      const result = encodeFilePath(windowsPath)
      // Should convert to forward slashes and add leading /
      expect(result).not.toContain("\\")
      expect(result).toMatch(/^\/[A-Za-z]:\//)
    })

    test("should handle relative paths the same on all platforms", () => {
      const unixRelative = "src/app.ts"
      const windowsRelative = "src\\app.ts"

      const unixResult = encodeFilePath(unixRelative)
      const windowsResult = encodeFilePath(windowsRelative)

      // Both should normalize to forward slashes
      expect(unixResult).toBe("src/app.ts")
      expect(windowsResult).toBe("src/app.ts")
    })
  })

  describe("Edge cases", () => {
    test("should handle empty path", () => {
      const result = encodeFilePath("")
      expect(result).toBe("")
    })

    test("should handle path with multiple consecutive slashes", () => {
      const result = encodeFilePath("//path//to///file.txt")
      // Multiple slashes should be preserved (backend handles normalization)
      expect(result).toBe("//path//to///file.txt")
    })

    test("should encode Unicode characters", () => {
      const unicodePath = "/home/user/文档/README.md"
      const result = encodeFilePath(unicodePath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      // Unicode should be encoded
      expect(result).toContain("%E6%96%87%E6%A1%A3")
    })

    test("should handle already normalized Windows path", () => {
      // Path that's already been normalized (has / before drive letter)
      const alreadyNormalized = "/D:/path/file.txt"
      const result = encodeFilePath(alreadyNormalized)

      // Should not add another leading slash
      expect(result).toBe("/D:/path/file.txt")
      expect(result).not.toContain("//D")
    })

    test("should handle just drive letter", () => {
      const justDrive = "D:"
      const result = encodeFilePath(justDrive)
      const fileUrl = `file://${result}`

      expect(result).toBe("/D:")
      expect(() => new URL(fileUrl)).not.toThrow()
    })

    test("should handle Windows path with trailing backslash", () => {
      const trailingBackslash = "C:\\Users\\test\\"
      const result = encodeFilePath(trailingBackslash)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/C:/Users/test/")
    })

    test("should handle very long paths", () => {
      const longPath = "C:\\Users\\test\\" + "verylongdirectoryname\\".repeat(20) + "file.txt"
      const result = encodeFilePath(longPath)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).not.toContain("\\")
    })

    test("should handle paths with dots", () => {
      const pathWithDots = "C:\\Users\\..\\test\\.\\file.txt"
      const result = encodeFilePath(pathWithDots)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      // Dots should be preserved (backend normalizes)
      expect(result).toContain("..")
      expect(result).toContain("/./")
    })
  })

  describe("Regression tests for PR #12424", () => {
    test("should handle file with # in name", () => {
      const path = "/path/to/file#name.txt"
      const result = encodeFilePath(path)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/path/to/file%23name.txt")
    })

    test("should handle file with ? in name", () => {
      const path = "/path/to/file?name.txt"
      const result = encodeFilePath(path)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/path/to/file%3Fname.txt")
    })

    test("should handle file with % in name", () => {
      const path = "/path/to/file%name.txt"
      const result = encodeFilePath(path)
      const fileUrl = `file://${result}`

      expect(() => new URL(fileUrl)).not.toThrow()
      expect(result).toBe("/path/to/file%25name.txt")
    })
  })

  describe("Integration with file:// URL construction", () => {
    test("should work with query parameters (Linux)", () => {
      const path = "/home/user/file.txt"
      const encoded = encodeFilePath(path)
      const fileUrl = `file://${encoded}?start=10&end=20`

      const url = new URL(fileUrl)
      expect(url.searchParams.get("start")).toBe("10")
      expect(url.searchParams.get("end")).toBe("20")
      expect(url.pathname).toBe("/home/user/file.txt")
    })

    test("should work with query parameters (Windows)", () => {
      const path = "C:\\Users\\test\\file.txt"
      const encoded = encodeFilePath(path)
      const fileUrl = `file://${encoded}?start=10&end=20`

      const url = new URL(fileUrl)
      expect(url.searchParams.get("start")).toBe("10")
      expect(url.searchParams.get("end")).toBe("20")
    })

    test("should parse correctly in URL constructor (Linux)", () => {
      const path = "/var/log/app.log"
      const fileUrl = `file://${encodeFilePath(path)}`
      const url = new URL(fileUrl)

      expect(url.protocol).toBe("file:")
      expect(url.pathname).toBe("/var/log/app.log")
    })

    test("should parse correctly in URL constructor (Windows)", () => {
      const path = "D:\\logs\\app.log"
      const fileUrl = `file://${encodeFilePath(path)}`
      const url = new URL(fileUrl)

      expect(url.protocol).toBe("file:")
      expect(url.pathname).toContain("app.log")
    })
  })
})
