import { describe, expect, test } from "bun:test"
import {
  fileIdentityKey,
  resolveWithinWorkspace,
  workspaceFoldsCase,
  type FileIdentityContext,
} from "./identity"

const windowsLocal: FileIdentityContext = { platform: "win32", kind: "local-filesystem" }
const windowsRemote: FileIdentityContext = { platform: "win32", kind: "remote-filesystem" }
const darwinLocal: FileIdentityContext = { platform: "darwin", kind: "local-filesystem" }
const linuxRemote: FileIdentityContext = { platform: "linux", kind: "remote-filesystem" }

const ok = (result: ReturnType<typeof resolveWithinWorkspace>) => {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`)
  return result
}

describe("workspace file identity", () => {
  test("windows local folds case for identity but keeps authoritative spelling", () => {
    const resolved = ok(
      resolveWithinWorkspace("C:\\Repo\\Src\\App.ts", { root: "C:/repo", context: windowsLocal }),
    )
    expect(resolved.path).toBe("Src/App.ts")
    expect(resolved.fileKey).toBe("src/app.ts")
    expect(resolved.name).toBe("App.ts")
    // Equivalent spellings merge into one node/requests, while the first
    // spelling stays the request path.
    const lower = ok(resolveWithinWorkspace("c:/repo/src/APP.ts", { root: "C:/repo", context: windowsLocal }))
    expect(lower.fileKey).toBe(resolved.fileKey)
    expect(lower.path).toBe("src/APP.ts")
  })

  test("windows segment boundaries: /repo2 never matches /repo", () => {
    expect(
      resolveWithinWorkspace("C:/repo2/file.ts", { root: "C:/repo", context: windowsLocal }),
    ).toMatchObject({ ok: false, reason: "outside-root" })
    expect(resolveWithinWorkspace("C:/repo/../outside.ts", { root: "C:/repo", context: windowsLocal })).toMatchObject(
      { ok: false, reason: "outside-root" },
    )
  })

  test("windows drive-relative and rooted-relative inputs are rejected as ambiguous", () => {
    expect(resolveWithinWorkspace("C:foo/bar.ts", { root: "C:/repo", context: windowsLocal })).toMatchObject({
      ok: false,
      reason: "ambiguous",
    })
    expect(resolveWithinWorkspace("\\foo/bar.ts", { root: "C:/repo", context: windowsLocal })).toMatchObject({
      ok: false,
      reason: "ambiguous",
    })
    // UNC stays absolute, not rooted-relative.
    const resolved = ok(
      resolveWithinWorkspace("\\\\SERVER\\share\\Repo\\src\\App.ts", {
        root: "//server/share/repo",
        context: windowsLocal,
      }),
    )
    expect(resolved.path).toBe("src/App.ts")
    expect(resolved.fileKey).toBe("src/app.ts")
  })

  test("windows relative separators convert under a windows workspace context", () => {
    const resolved = ok(resolveWithinWorkspace("src\\App.ts", { root: "C:/repo", context: windowsLocal }))
    expect(resolved.path).toBe("src/App.ts")
    expect(resolved.fileKey).toBe("src/app.ts")
  })

  test("different windows drives and shares never share a workspace", () => {
    expect(resolveWithinWorkspace("D:/repo/file.ts", { root: "C:/repo", context: windowsLocal })).toMatchObject({
      ok: false,
      reason: "outside-root",
    })
    expect(
      resolveWithinWorkspace("//server/other/file.ts", { root: "//server/share", context: windowsLocal }),
    ).toMatchObject({ ok: false, reason: "outside-root" })
  })

  test("posix keeps case and backslash filenames; darwin does not fold case", () => {
    expect(workspaceFoldsCase(darwinLocal)).toBe(false)
    const resolved = ok(resolveWithinWorkspace("/Users/x/repo/src/a\\b.ts", { root: "/Users/x/repo", context: darwinLocal }))
    expect(resolved.path).toBe("src/a\\b.ts")
    expect(resolved.name).toBe("a\\b.ts")
    expect(resolved.fileKey).toBe("src/a\\b.ts")

    expect(fileIdentityKey("SRC/App.ts", darwinLocal)).toBe("SRC/App.ts")
    expect(fileIdentityKey("SRC/App.ts", windowsLocal)).toBe("src/app.ts")
    expect(fileIdentityKey("SRC/App.ts", linuxRemote)).toBe("SRC/App.ts")
    expect(fileIdentityKey("SRC/App.ts", windowsRemote)).toBe("SRC/App.ts")
  })

  test("relative dot segments resolve within the root and never escape", () => {
    expect(
      ok(resolveWithinWorkspace("src/../app.ts", { root: "/repo", context: linuxRemote })),
    ).toMatchObject({ path: "app.ts" })
    expect(resolveWithinWorkspace("../outside.ts", { root: "/repo", context: linuxRemote })).toMatchObject({
      ok: false,
      reason: "escape",
    })
    expect(resolveWithinWorkspace("", { root: "/repo", context: linuxRemote })).toMatchObject({
      ok: false,
      reason: "empty",
    })
  })

  test("virtual and url namespaces stay opaque", () => {
    const virtual: FileIdentityContext = { platform: "linux", kind: "virtual" }
    const resolved = ok(resolveWithinWorkspace("Weird\\Value/../x", { root: "anything", context: virtual }))
    expect(resolved.path).toBe("Weird\\Value/../x")
    expect(resolved.fileKey).toBe("Weird\\Value/../x")
  })
})
