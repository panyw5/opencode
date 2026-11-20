import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitCommit, gitPush, gitStatus } from "./git"

let temp: string
let repo: string
let inheritedGitEnv: Record<string, string | undefined>

function git(cwd: string, args: string[], input?: string) {
  return execFileSync("git", ["--no-pager", ...args], { cwd, input, encoding: "utf8" }).replace(/\n$/, "")
}

function seed(parent?: string) {
  const tree = git(repo, ["write-tree"])
  return git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "fixture"])
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), "opencode-desktop-git-")))
  inheritedGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^GIT_/i.test(key)))
  for (const key of Object.keys(inheritedGitEnv)) delete process.env[key]
  process.env.GIT_CONFIG_GLOBAL = join(temp, "no-global-config")
  process.env.GIT_CONFIG_NOSYSTEM = "1"
  process.env.GIT_ALLOW_PROTOCOL = "file"
  repo = join(temp, "repo")
  await mkdir(repo)
  git(repo, ["init", "-q", "-b", "main"])
  git(repo, ["config", "user.name", "Desktop Git Test"])
  git(repo, ["config", "user.email", "desktop-git@example.invalid"])
})

afterEach(async () => {
  delete process.env.GIT_CONFIG_GLOBAL
  delete process.env.GIT_CONFIG_NOSYSTEM
  delete process.env.GIT_ALLOW_PROTOCOL
  for (const [key, value] of Object.entries(inheritedGitEnv)) if (value !== undefined) process.env[key] = value
  await rm(temp, { recursive: true, force: true })
})

async function baseline() {
  await writeFile(join(repo, "tracked"), "original\n")
  await writeFile(join(repo, "other"), "original\n")
  git(repo, ["add", "--", "tracked", "other"])
  const oid = seed()
  git(repo, ["update-ref", "refs/heads/main", oid])
  return oid
}

describe("Git status and rejecting unsafe requests", () => {
  test("finds the root from a subdirectory and reports unborn, tracked, and detached status", async () => {
    const sub = join(repo, "nested")
    await mkdir(sub)
    await writeFile(join(sub, "--new"), "new\n")
    expect(await gitStatus(temp)).toBeNull()
    expect(await gitStatus(sub)).toEqual({
      root: repo,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      lastCommit: null,
      files: [{ path: "nested/--new", status: "??", untracked: true }],
    })
    const oid = await baseline()
    git(repo, ["checkout", "--detach", "-q", oid])
    await writeFile(join(repo, "tracked"), "changed\n")
    expect(await gitStatus(sub)).toMatchObject({
      branch: null,
      lastCommit: expect.stringMatching(/^[0-9a-f]+ fixture$/),
      files: expect.arrayContaining([{ path: "tracked", status: " M", untracked: false }]),
    })
  })

  test("rejects malformed input, changed branch, stale selection, and missing upstream", async () => {
    await baseline()
    await writeFile(join(repo, "new"), "new\n")
    const request = { branch: "main", paths: ["new"], message: "message" }
    const index = await readFile(join(repo, ".git", "index"))
    await expect(gitStatus(".")).rejects.toThrow("absolute local directory")
    for (const paths of [["../new"], [join(repo, "new")], ["new", "new"], [], [null], ["new\0"]]) {
      await expect(gitCommit(repo, { ...request, paths })).rejects.toThrow("repository-relative")
    }
    await expect(gitCommit(repo, { ...request, message: "  " })).rejects.toThrow("commit message")
    await expect(gitCommit(repo, { ...request, branch: "stale" })).rejects.toThrow("branch changed")
    await expect(gitCommit(repo, { ...request, paths: ["tracked"] })).rejects.toThrow("Not a current Git change")
    await expect(gitPush(repo, { branch: "main", upstream: "origin/main" })).rejects.toThrow("No matching upstream")
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index)
  })

  test("rejects a sequencer operation even with no conflicts, and rejects unmerged entries without a marker", async () => {
    const oid = await baseline()
    await writeFile(join(repo, "new"), "new\n")
    const request = { branch: "main", paths: ["new"], message: "message" }
    const mergeHead = join(repo, ".git", "MERGE_HEAD")
    await writeFile(mergeHead, oid + "\n")
    await expect(gitCommit(repo, request)).rejects.toThrow("operation in progress")
    await expect(gitPush(repo, { branch: "main", upstream: "origin/main" })).rejects.toThrow("operation in progress")
    await rm(mergeHead)
    const blob = git(repo, ["rev-parse", "HEAD:tracked"])
    git(repo, ["update-index", "--force-remove", "--", "tracked"])
    git(repo, ["update-index", "--index-info"], `100644 ${blob} 1\ttracked\n100644 ${blob} 2\ttracked\n`)
    await expect(gitCommit(repo, request)).rejects.toThrow("Resolve Git conflicts")
  })

  test("rejects a file/directory replacement and leaves an existing Git index lock alone", async () => {
    await baseline()
    await rm(join(repo, "tracked"))
    await mkdir(join(repo, "tracked"))
    await writeFile(join(repo, "tracked", "child"), "untracked\n")
    const request = { branch: "main", paths: ["tracked/child"], message: "Not an isolated change" }
    await expect(gitCommit(repo, request)).rejects.toThrow("File/directory replacement")
    const lock = join(repo, ".git", "index.lock")
    await writeFile(lock, "another writer")
    await expect(gitCommit(repo, request)).rejects.toThrow("EEXIST")
    expect(await readFile(lock, "utf8")).toBe("another writer")
  })
})

describe("Git commit and push integration", () => {
  test("commits selected working-tree content and an untracked literal filename without touching unrelated changes", async () => {
    await baseline()
    await writeFile(join(repo, "other"), "staged\n")
    await writeFile(join(repo, "tracked"), "staged tracked\n")
    git(repo, ["add", "--", "other", "tracked"])
    await writeFile(join(repo, "other"), "unstaged\n")
    await writeFile(join(repo, "tracked"), "selected working tree\n")
    const literal = process.platform === "win32" ? "--[literal]" : ":(glob)[literal]\nname"
    await writeFile(join(repo, literal), "literal content\n")
    await writeFile(join(repo, "not-selected"), "untracked\n")
    await gitCommit(repo, { branch: "main", paths: [literal, "tracked"], message: "Selected paths" })
    expect(git(repo, ["show", "HEAD:tracked"])).toBe("selected working tree")
    expect(git(repo, ["show", `HEAD:${literal}`])).toBe("literal content")
    expect(git(repo, ["show", "HEAD:other"])).toBe("original")
    expect(git(repo, ["show", ":other"])).toBe("staged")
    expect(await readFile(join(repo, "other"), "utf8")).toBe("unstaged\n")
    expect((await gitStatus(repo))?.files).toEqual([
      { path: "other", status: "MM", untracked: false },
      { path: "not-selected", status: "??", untracked: true },
    ])
  })

  test("commits only selected files on an unborn branch", async () => {
    await writeFile(join(repo, "other"), "staged\n")
    await writeFile(join(repo, "tracked"), "selected\n")
    git(repo, ["add", "--", "other"])
    await gitCommit(repo, { branch: "main", paths: ["tracked"], message: "First" })
    expect(git(repo, ["ls-tree", "--name-only", "HEAD"])).toBe("tracked")
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("other")
  })

  test("commits a selected deletion but leaves an unrelated staged deletion in the index", async () => {
    await baseline()
    await rm(join(repo, "tracked"))
    git(repo, ["rm", "--", "other"])
    await gitCommit(repo, { branch: "main", paths: ["tracked"], message: "Remove tracked" })
    expect(git(repo, ["ls-tree", "--name-only", "HEAD"])).toBe("other")
    expect(git(repo, ["diff", "--cached", "--name-status"])).toBe("D\tother")
  })

  test("a signing failure leaves the real index byte-for-byte unchanged", async () => {
    const oid = await baseline()
    await writeFile(join(repo, "new"), "new\n")
    git(repo, ["config", "commit.gpgsign", "true"])
    git(repo, ["config", "gpg.program", join(temp, "missing-gpg")])
    const index = await readFile(join(repo, ".git", "index"))
    await expect(gitCommit(repo, { branch: "main", paths: ["new"], message: "Fail" })).rejects.toThrow(/gpg/i)
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index)
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(oid)
  })

  test("pushes exactly the configured branch to a local bare remote, and rejects a non-fast-forward", async () => {
    const base = await baseline()
    const remote = join(temp, "remote.git")
    git(temp, ["init", "--bare", "-q", remote])
    git(repo, ["remote", "add", "origin", remote])
    git(remote, ["fetch", repo, "refs/heads/main:refs/heads/destination"])
    git(repo, ["fetch", "origin"])
    git(repo, ["branch", "--set-upstream-to=origin/destination"])
    const ahead = seed(base)
    git(repo, ["update-ref", "refs/heads/main", ahead])
    git(repo, ["update-ref", "refs/heads/unrelated", ahead])
    git(repo, ["tag", "-a", "tag", "-m", "Extra tag"])
    git(repo, ["config", "remote.origin.mirror", "true"])
    git(repo, ["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"])
    git(repo, ["config", "push.followTags", "true"])
    expect(await gitStatus(repo)).toMatchObject({ upstream: "origin/destination", ahead: 1, behind: 0 })
    const request = { branch: "main", upstream: "origin/destination" }
    await expect(gitPush(repo, { ...request, upstream: "origin/main" })).rejects.toThrow("No matching upstream")
    git(repo, ["config", "--add", "remote.origin.pushurl", remote])
    git(repo, ["config", "--add", "remote.origin.pushurl", join(temp, "second.git")])
    await expect(gitPush(repo, request)).rejects.toThrow("exactly one push URL")
    git(repo, ["config", "--unset-all", "remote.origin.pushurl"])
    await gitPush(repo, request)
    expect(git(remote, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(`refs/heads/destination ${ahead}`)
    git(repo, ["update-ref", "refs/heads/main", base])
    await expect(gitPush(repo, request)).rejects.toThrow(/rejected/)
    expect(git(remote, ["rev-parse", "refs/heads/destination"])).toBe(ahead)
    expect(await gitStatus(repo)).toMatchObject({ ahead: 0, behind: 1 })
  })
})
