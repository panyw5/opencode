import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Global } from "@opencode-ai/core/global"
import { createHash } from "crypto"
import {
  InvalidRepositoryBranchError,
  InvalidRepositoryReferenceError,
  UnsupportedLocalRepositoryError,
  isFileRepositoryReference,
  isRemoteRepositoryReference,
  parseRemoteRepositoryReference,
  parseRepositoryReference,
  repositoryCacheIdentity,
  repositoryCachePath,
  sameRepositoryReference,
  validateRepositoryBranch,
} from "../../src/util/repository"

describe("util.repository", () => {
  const digest = (values: readonly string[]) => createHash("sha256").update(JSON.stringify(values)).digest("hex")

  test("parses github shorthand and preserves cache path", () => {
    const reference = parseRemoteRepositoryReference("owner/repo")

    expect(reference).toMatchObject({
      host: "github.com",
      path: "owner/repo",
      segments: ["owner", "repo"],
      owner: "owner",
      repo: "repo",
      label: "owner/repo",
    })
    expect(repositoryCachePath(reference)).toBe(
      path.join(Global.Path.data, "repository-cache-v2", "default", digest(["github.com", "owner", "repo"])),
    )
    expect(repositoryCachePath(reference, "feature/docs.v1")).toBe(
      path.join(
        Global.Path.data,
        "repository-cache-v2",
        "branches",
        digest(["github.com", "owner", "repo"]),
        digest(["feature/docs.v1"]),
      ),
    )
    expect(repositoryCachePath(reference, "release@2026")).toBe(
      path.join(
        Global.Path.data,
        "repository-cache-v2",
        "branches",
        digest(["github.com", "owner", "repo"]),
        digest(["release@2026"]),
      ),
    )
    expect(repositoryCacheIdentity(reference)).toBe("github.com/owner/repo")
  })

  test("keeps branch paths distinct from branchless repositories containing the old delimiter", () => {
    const branched = parseRemoteRepositoryReference("owner/repo")
    const branchless = parseRemoteRepositoryReference("owner/repo@main")

    expect(repositoryCachePath(branched, "main")).not.toBe(repositoryCachePath(branchless))
    expect(repositoryCachePath(branched, "main")).not.toContain("repo@main")
  })

  test("parses host path and scp remote references", () => {
    const hostPath = parseRemoteRepositoryReference("gitlab.com/group/repo")
    const scp = parseRemoteRepositoryReference("git@github.com:owner/repo.git")

    expect(hostPath).toMatchObject({
      host: "gitlab.com",
      path: "group/repo",
      remote: "https://gitlab.com/group/repo.git",
      label: "gitlab.com/group/repo",
    })
    expect(scp).toMatchObject({
      host: "github.com",
      path: "owner/repo",
      remote: "git@github.com:owner/repo.git",
      label: "owner/repo",
    })
  })

  test("keeps local file repositories distinct from remote repositories", () => {
    const localPath = path.resolve("repo.git")
    const reference = parseRepositoryReference(pathToFileURL(localPath).href)

    expect(reference).toMatchObject({
      host: "file",
      protocol: "file:",
      label: localPath,
    })
    expect(reference && isFileRepositoryReference(reference)).toBe(true)
    expect(reference && isRemoteRepositoryReference(reference)).toBe(false)
    expect(() => parseRemoteRepositoryReference(pathToFileURL(localPath).href)).toThrow(
      "Local file repositories are not supported",
    )
    expect(() => parseRemoteRepositoryReference(pathToFileURL(localPath).href)).toThrow(UnsupportedLocalRepositoryError)
  })

  test("rejects invalid remote repository references with typed errors", () => {
    expect(() => parseRemoteRepositoryReference("not-a-repo")).toThrow(InvalidRepositoryReferenceError)
    expect(() => parseRemoteRepositoryReference("git@github.com:../../../etc/passwd")).toThrow(
      InvalidRepositoryReferenceError,
    )
    expect(() => parseRemoteRepositoryReference("https://../owner/repo")).toThrow(InvalidRepositoryReferenceError)
    expect(() => parseRemoteRepositoryReference("https://%2e%2e/owner/repo")).toThrow(InvalidRepositoryReferenceError)
  })

  test("keeps port-bearing and IPv6 hosts in one encoded cache segment", () => {
    const port = parseRemoteRepositoryReference("https://example.com:8443/owner/repo")
    const nested = parseRemoteRepositoryReference("example.com/8443/owner/repo")
    const ipv6 = parseRemoteRepositoryReference("https://[::1]:8443/owner/repo")

    expect(repositoryCachePath(port)).not.toBe(repositoryCachePath(nested))
    expect(repositoryCachePath(port, "main")).not.toBe(repositoryCachePath(nested, "main"))
    expect(repositoryCachePath(port)).toContain(digest(["example.com:8443", "owner", "repo"]))
    expect(repositoryCachePath(ipv6)).toContain(digest(["[::1]:8443", "owner", "repo"]))
  })

  test("keeps case-sensitive repository segments distinct on case-insensitive filesystems", () => {
    const lower = parseRemoteRepositoryReference("owner/repo")
    const upper = parseRemoteRepositoryReference("Owner/Repo")

    expect(repositoryCachePath(lower)).not.toBe(repositoryCachePath(upper))
    expect(repositoryCachePath(lower, "main")).not.toBe(repositoryCachePath(upper, "main"))
  })

  test("bounds canonical path components for long repository and branch names", () => {
    const reference = parseRemoteRepositoryReference(`owner/${"r".repeat(200)}`)
    const cache = repositoryCachePath(reference, `${"feature/"}${"b".repeat(200)}`)

    for (const component of cache.split(path.sep).filter(Boolean))
      expect(Buffer.byteLength(component)).toBeLessThan(255)
  })

  test("compares cache identity independent of input spelling", () => {
    const shorthand = parseRemoteRepositoryReference("owner/repo")
    const url = parseRemoteRepositoryReference("https://github.com/owner/repo.git")
    const hostPath = parseRemoteRepositoryReference("github.com/owner/repo")

    expect(sameRepositoryReference(shorthand, url)).toBe(true)
    expect(sameRepositoryReference(shorthand, hostPath)).toBe(true)
  })

  test("validates repository branch names", () => {
    expect(() => validateRepositoryBranch("feature/docs.v1")).not.toThrow()
    for (const branch of ["-bad", "bad..branch", "bad branch", ".", "main.", "/", "a//b", ".hidden/main"]) {
      expect(() => validateRepositoryBranch(branch)).toThrow("Branch must contain only alphanumeric characters")
    }
    expect(() => validateRepositoryBranch("bad branch")).toThrow(InvalidRepositoryBranchError)
  })
})
