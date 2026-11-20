import { execFile } from "node:child_process"
import { copyFile, lstat, mkdtemp, open, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import type { GitStatus } from "../preload/types"

function git(root: string, args: string[], options?: { index?: string; input?: string }) {
  const env = { ...process.env }
  // Use normal Git config and authentication, but not an inherited repo, index or pathspec mode.
  for (const key of Object.keys(env)) {
    if (
      /^GIT_/i.test(key) &&
      !/^GIT_(CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|ALLOW_PROTOCOL|SSH|SSH_COMMAND|SSH_VARIANT)$/i.test(key)
    )
      delete env[key]
  }
  Object.assign(env, { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" })
  if (options?.index) env.GIT_INDEX_FILE = options.index
  return new Promise<Buffer>((resolve, reject) => {
    const child = execFile(
      "git",
      ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", ...args],
      { cwd: root, env, encoding: "buffer", windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        const message = stderr
          .toString()
          .replace(/([a-z][a-z\d+.-]*:\/\/)[^/\s]*@/gi, "$1[redacted]@")
          .trim()
        reject(new Error(message || `Git failed (${error.code ?? error.signal ?? "unknown error"})`))
      },
    )
    child.stdin?.on("error", () => {}) // Git may exit before consuming the selection.
    child.stdin?.end(options?.input)
  })
}

function decode(output: Buffer) {
  // Lossy decoding could make a selected filename refer to a different file.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output)
}

async function line(root: string, args: string[]) {
  return decode(await git(root, args)).replace(/\n$/, "")
}

function missing(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && value.isWellFormed()
}

async function rootOf(directory: unknown) {
  if (!text(directory) || !isAbsolute(directory)) throw new Error("Expected an absolute local directory")
  try {
    if (!(await stat(directory)).isDirectory()) return null
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  try {
    return await line(directory, ["rev-parse", "--show-toplevel"])
  } catch (error) {
    if (
      error instanceof Error &&
      /^fatal: (not a git repository|this operation must be run in a work tree)/.test(error.message)
    )
      return null
    throw error
  }
}

async function snapshot(root: string) {
  const output = decode(
    await git(root, [
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--ahead-behind",
      "--untracked-files=all",
      "--no-renames",
      "--ignore-submodules=none",
    ]),
  )
  let branch = ""
  let upstream: string | null = null
  let oid = ""
  let ahead = 0
  let behind = 0
  let conflicted = false
  const files = new Map<string, GitStatus["files"][number]>()
  const untracked = new Set<string>()
  for (const record of output.split("\0")) {
    if (record.startsWith("# branch.head ")) branch = record.slice(14)
    if (record.startsWith("# branch.oid ")) oid = record.slice(13)
    if (record.startsWith("# branch.upstream ")) upstream = record.slice(18)
    const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
    if (counts) {
      ahead = Number(counts[1])
      behind = Number(counts[2])
    }
    if (record.startsWith("? ")) {
      const path = record.slice(2)
      untracked.add(path)
      // A staged deletion can also appear as an untracked file at the same path.
      if (!files.has(path)) files.set(path, { path, status: "??", untracked: true })
      continue
    }
    if (!record || record.startsWith("# ")) continue
    const entry = /^(?:1 (\S{2})(?: \S+){6}|u (\S{2})(?: \S+){8}) (.+)$/s.exec(record)
    if (!entry) throw new Error("Unexpected Git status entry")
    if (entry[2]) conflicted = true
    const path = entry[3]!
    files.set(path, { path, status: (entry[1] ?? entry[2]!).replaceAll(".", " "), untracked: false })
  }
  if (!branch || (oid !== "(initial)" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)))
    throw new Error("Git did not report the current branch and commit")
  return {
    root,
    branch: branch === "(detached)" ? null : branch,
    upstream,
    ahead,
    behind,
    files: [...files.values()],
    untracked,
    oid,
    conflicted,
  }
}

export async function gitStatus(directory: unknown): Promise<GitStatus | null> {
  const root = await rootOf(directory)
  if (!root) return null
  const { oid, conflicted: _conflicted, untracked: _untracked, ...status } = await snapshot(root)
  const lastCommit = oid === "(initial)" ? null : await line(root, ["log", "-1", "--format=%h %s", oid, "--"])
  return { ...status, lastCommit }
}

function inputObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || !input || Array.isArray(input)) throw new Error("Invalid Git request")
  return input as Record<string, unknown>
}

function relativeFile(path: unknown): path is string {
  return (
    text(path) &&
    !isAbsolute(path) &&
    !(process.platform === "win32" && /[:\\]/.test(path)) &&
    path.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  )
}

async function present(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

async function gitPath(root: string, path: string) {
  return line(root, ["rev-parse", "--path-format=absolute", "--git-path", path])
}

async function requireIdle(root: string) {
  const gitDir = await line(root, ["rev-parse", "--absolute-git-dir"])
  const states = [
    "MERGE_HEAD",
    "MERGE_AUTOSTASH",
    "SQUASH_MSG",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_START",
  ]
  const active = await Promise.all(states.map((state) => present(join(gitDir, state))))
  if (active.some(Boolean)) throw new Error("Finish the Git operation in progress before using the commit panel")
}

function requireBranch(current: string | null, expected: string) {
  if (current !== expected) throw new Error("The checked-out branch changed. Refresh Git status and try again")
}

export async function gitCommit(directory: unknown, input: unknown): Promise<void> {
  const { paths, message, branch } = inputObject(input)
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    !Array.from(paths).every(relativeFile) ||
    new Set(paths).size !== paths.length
  )
    throw new Error("Expected unique repository-relative file paths")
  if (!text(message) || !message.trim() || !text(branch)) throw new Error("Expected a commit message and branch")
  const root = await rootOf(directory)
  if (!root) throw new Error("Not a Git worktree")
  const index = await gitPath(root, "index")
  const lock = `${index}.lock`
  // Keep ordinary Git writers out while validating and preparing a copy of the index.
  const handle = await open(lock, "wx")
  let scratch: string | undefined
  try {
    await requireIdle(root)
    const status = await snapshot(root)
    requireBranch(status.branch, branch)
    if (status.conflicted) throw new Error("Resolve Git conflicts before committing")
    const live = new Set(status.files.map((entry) => entry.path))
    const parents = new Set<string>()
    const replacements = new Set<string>()
    for (const path of live) {
      for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
        const parent = path.slice(0, slash)
        parents.add(parent)
        if (live.has(parent)) replacements.add(path)
      }
    }
    const untracked: string[] = []
    for (const path of paths) {
      if (!live.has(path)) throw new Error(`Not a current Git change: ${path}`)
      if (parents.has(path) || replacements.has(path)) throw new Error(`File/directory replacement: ${path}`)
      const file = await present(join(root, path))
      // Even literal pathspecs recurse into directories. This panel only accepts individual files.
      if (file && !file.isFile() && !file.isSymbolicLink()) throw new Error(`Not an individual file: ${path}`)
      if (status.untracked.has(path)) {
        if (!file) throw new Error(`Untracked file disappeared: ${path}`)
        untracked.push(path)
      }
    }
    scratch = await mkdtemp(join(dirname(index), "opencode-git-"))
    const candidate = join(scratch, "index")
    if (await present(index)) await copyFile(index, candidate)
    const pathspec = ["--pathspec-from-file=-", "--pathspec-file-nul"]
    const config = ["-c", "core.splitIndex=false", "-c", "submodule.recurse=false"]
    if (untracked.length) {
      await git(root, [...config, "add", "--intent-to-add", ...pathspec], {
        index: candidate,
        input: untracked.join("\0") + "\0",
      })
    }
    // Hooks can stage additional paths in Git's partial-commit index. Use an empty hooks directory
    // to enforce the selection; signing and normal Git identity still apply.
    const selection = join(scratch, "paths")
    await writeFile(selection, paths.join("\0") + "\0")
    await requireIdle(root)
    requireBranch(await line(root, ["symbolic-ref", "HEAD"]), `refs/heads/${branch}`)
    await git(
      root,
      [
        ...config,
        "-c",
        `core.hooksPath=${scratch}`,
        "commit",
        "--only",
        "-F",
        "-",
        `--pathspec-from-file=${selection}`,
        "--pathspec-file-nul",
      ],
      { index: candidate, input: message },
    )
    // Install Git's updated index, including its untouched entries, only after the commit succeeds.
    try {
      await rename(candidate, index)
    } catch (error) {
      throw new Error("Commit created, but updating the index failed. Review Git status before retrying.", {
        cause: error,
      })
    }
  } finally {
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true })
    } finally {
      await handle.close()
      await rm(lock, { force: true })
    }
  }
}

export async function gitPush(directory: unknown, input: unknown): Promise<void> {
  const { branch, upstream } = inputObject(input)
  if (!text(branch) || !text(upstream)) throw new Error("Expected a branch and its configured upstream")
  const root = await rootOf(directory)
  if (!root) throw new Error("Not a Git worktree")
  await requireIdle(root)
  const status = await snapshot(root)
  requireBranch(status.branch, branch)
  if (status.conflicted) throw new Error("Resolve Git conflicts before pushing")
  if (status.upstream !== upstream || status.oid === "(initial)")
    throw new Error("No matching upstream for this branch")
  const ref = `refs/heads/${branch}`
  const [local, tracking, remote, destination] = (
    await line(root, [
      "for-each-ref",
      "--format=%(refname)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
      "--",
      ref,
    ])
  ).split("\0")
  if (
    local !== ref ||
    tracking !== upstream ||
    !remote ||
    remote === "." ||
    remote.includes("=") ||
    !destination?.startsWith("refs/heads/")
  )
    throw new Error("Expected one configured remote branch upstream")
  await git(root, ["check-ref-format", destination])
  const urls = await line(root, ["remote", "get-url", "--push", "--all", "--", remote])
  if (!urls || urls.includes("\n")) throw new Error("The upstream remote must have exactly one push URL")
  requireBranch(await line(root, ["symbolic-ref", "HEAD"]), ref)
  await git(root, [
    "-c",
    `remote.${remote}.mirror=false`,
    "-c",
    "push.pushOption=",
    "push",
    "--no-follow-tags",
    "--no-force",
    "--no-force-with-lease",
    "--recurse-submodules=no",
    "--",
    remote,
    `${status.oid}^{commit}:${destination}`,
  ])
}
