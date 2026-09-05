import { describe, expect, test } from "bun:test"
import type { SshTarget } from "./exec"
import {
  parseDirectoryListing,
  parseSshTarget,
  remotePath,
  shellEscape,
  sshArgs,
  sshDestination,
} from "./exec"

describe("parseSshTarget", () => {
  test("parses user@host:port", () => {
    expect(parseSshTarget("amy@server.example.com:2222")).toEqual({
      raw: "amy@server.example.com:2222",
      user: "amy",
      host: "server.example.com",
      port: 2222,
    })
  })

  test("parses host:port without user", () => {
    expect(parseSshTarget("server.example.com:2200")).toEqual({
      raw: "server.example.com:2200",
      user: null,
      host: "server.example.com",
      port: 2200,
    })
  })

  test("parses user@host without port", () => {
    expect(parseSshTarget("amy@server.example.com")).toEqual({
      raw: "amy@server.example.com",
      user: "amy",
      host: "server.example.com",
      port: null,
    })
  })

  test("passes bare config aliases through untouched", () => {
    expect(parseSshTarget("my-alias")).toEqual({
      raw: "my-alias",
      user: null,
      host: "my-alias",
      port: null,
    })
  })

  test("trims surrounding whitespace", () => {
    expect(parseSshTarget("  my-alias  ")?.raw).toBe("my-alias")
  })

  test("rejects empty or spaced targets", () => {
    expect(parseSshTarget("")).toBeNull()
    expect(parseSshTarget("host with space")).toBeNull()
    expect(parseSshTarget("a b@c")).toBeNull()
  })
})

describe("sshArgs", () => {
  test("adds BatchMode, ConnectTimeout and destination", () => {
    const target = parseSshTarget("amy@host") as SshTarget
    const args = sshArgs(target, "printf ok")
    expect(args).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=4",
      "--",
      "amy@host",
      "printf ok",
    ])
  })

  test("maps explicit port to -p and keeps it before the destination", () => {
    const target = parseSshTarget("host:2222") as SshTarget
    const args = sshArgs(target, null, ["-N", "-L", "127.0.0.1:4000:127.0.0.1:4000"])
    expect(args).toContain("-p")
    expect(args).toContain("2222")
    expect(args.indexOf("-p")).toBeLessThan(args.indexOf("--"))
    // Options come before the destination; with no remote script the
    // destination is the final argv element.
    expect(args[args.indexOf("--") + 1]).toBe("host")
    expect(args[args.length - 1]).toBe("host")
    expect(args).toContain("127.0.0.1:4000:127.0.0.1:4000")
  })
})

describe("shellEscape / remotePath", () => {
  test("escapes single quotes", () => {
    expect(shellEscape("it's")).toBe(`'it'"'"'s'`)
  })

  test("keeps ~ and $HOME expansion working", () => {
    expect(remotePath("~")).toBe("$HOME")
    expect(remotePath("~/projects")).toBe("$HOME/'projects'")
  })

  test("escapes absolute paths fully", () => {
    expect(remotePath("/home/amy/my dir")).toBe("'/home/amy/my dir'")
  })
})

describe("parseDirectoryListing", () => {
  test("marks trailing-slash entries as directories and joins paths", () => {
    const entries = parseDirectoryListing("project/\nnotes.txt\n.git/\n", "~/src")
    expect(entries).toEqual([
      { name: "project", path: "~/src/project", kind: "directory" },
      { name: "notes.txt", path: "~/src/notes.txt", kind: "file" },
      { name: ".git", path: "~/src/.git", kind: "directory" },
    ])
  })

  test("handles root base path", () => {
    const entries = parseDirectoryListing("home/\netc/\n", "/")
    expect(entries.map((entry) => entry.path)).toEqual(["/home", "/etc"])
  })

  test("drops . and .. entries and empty lines", () => {
    expect(parseDirectoryListing("./\n../\n\n", "/srv")).toEqual([])
  })
})

describe("sshDestination", () => {
  test("joins user and host", () => {
    expect(sshDestination(parseSshTarget("amy@host:22") as SshTarget)).toBe("amy@host")
    expect(sshDestination(parseSshTarget("host") as SshTarget)).toBe("host")
  })
})
