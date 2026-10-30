import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Flock } from "@opencode-ai/core/util/flock"
import { randomUUID } from "node:crypto"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Schema.Struct({
  // Optional because legacy/imported `summary_diffs` on disk may omit
  // file details and patch text. Required Schema rejected the whole
  // session response and broke session loading on Desktop.
  file: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  // Byte size of the file after the change (before-side size for deletions).
  // Optional so legacy/imported `summary_diffs` on disk without it still parse.
  size: Schema.optional(Schema.Finite),
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "SnapshotFileDiff" })
export type FileDiff = typeof FileDiff.Type

const log = Log.create({ service: "snapshot" })
const patchGeneration = Semaphore.makeUnsafe(1)
const prune = "7.days"
const limit = 2 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]

function unquotePath(input: string) {
  if (!input.startsWith('"') || !input.endsWith('"')) return input
  const bytes: number[] = []
  for (let i = 1; i < input.length - 1; i++) {
    const char = input[i]!
    if (char !== "\\") {
      const codePoint = String.fromCodePoint(input.codePointAt(i)!)
      bytes.push(...Buffer.from(codePoint))
      i += codePoint.length - 1
      continue
    }
    const next = input[++i]
    if (!next) break
    if (next >= "0" && next <= "7") {
      const match = input.slice(i, i + 3).match(/^[0-7]{1,3}/)?.[0]
      if (match) {
        bytes.push(parseInt(match, 8))
        i += match.length - 1
        continue
      }
    }
    bytes.push(
      ...Buffer.from(
        next === "n"
          ? "\n"
          : next === "r"
            ? "\r"
            : next === "t"
              ? "\t"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next === "v"
                    ? "\v"
                    : next,
      ),
    )
  }
  return Buffer.from(bytes).toString()
}

function gitPatchPath(patch: string) {
  const header = patch.slice(0, patch.indexOf("\n"))
  const body = header.slice("diff --git ".length)
  for (let i = 1; i < body.length; i++) {
    if (body[i] === " " && body.slice(0, i) === body.slice(i + 1)) return unquotePath(body.slice(0, i))
  }
  return undefined
}

interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

class CaptureError extends Schema.TaggedErrorClass<CaptureError>()("SnapshotCaptureError", {
  operation: Schema.String,
}) {}

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string, files?: ReadonlySet<string>) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | AppProcess.Service | Config.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const appProcess = yield* AppProcess.Service
      const config = yield* Config.Service
      const locks = new Map<string, Semaphore.Semaphore>()

      const lock = (key: string) => {
        const hit = locks.get(key)
        if (hit) return hit

        const next = Semaphore.makeUnsafe(1)
        locks.set(key, next)
        return next
      }

      const state = yield* InstanceState.make<State>(
        Effect.fn("Snapshot.state")(function* (ctx) {
          const state = {
            directory: ctx.directory,
            worktree: ctx.worktree,
            gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
            vcs: ctx.project.vcs,
          }
          const patchCache = new Map<string, { patch: string; bytes: number }>()
          const snapshotDiffCache = new Map<string, { patch?: string; size?: number; binary: boolean; bytes: number }>()
          let patchCacheBytes = 0
          let snapshotDiffCacheBytes = 0
          const patchCacheMaxEntries = 128
          const patchCacheMaxBytes = 4 * 1024 * 1024
          const patchKey = (file: string, status: string, before: string, after: string) =>
            `${file}\0${status}\0${Hash.fast(before)}\0${Hash.fast(after)}\0git-full-v1`
          const rememberPatch = (key: string, patch: string) => {
            const bytes = Buffer.byteLength(patch)
            if (bytes > patchCacheMaxBytes) return
            const previous = patchCache.get(key)
            if (previous) patchCacheBytes -= previous.bytes
            patchCache.delete(key)
            patchCache.set(key, { patch, bytes })
            patchCacheBytes += bytes
            while (patchCache.size > patchCacheMaxEntries || patchCacheBytes > patchCacheMaxBytes) {
              const oldest = patchCache.entries().next().value as [string, { patch: string; bytes: number }] | undefined
              if (!oldest) break
              patchCache.delete(oldest[0])
              patchCacheBytes -= oldest[1].bytes
            }
          }
          const rememberSnapshotDiff = (key: string, value: { patch?: string; size?: number; binary: boolean }) => {
            const bytes = Buffer.byteLength(value.patch ?? "") + 64
            if (bytes > patchCacheMaxBytes) return
            const previous = snapshotDiffCache.get(key)
            if (previous) snapshotDiffCacheBytes -= previous.bytes
            snapshotDiffCache.delete(key)
            snapshotDiffCache.set(key, { ...value, bytes })
            snapshotDiffCacheBytes += bytes
            while (snapshotDiffCache.size > patchCacheMaxEntries || snapshotDiffCacheBytes > patchCacheMaxBytes) {
              const oldest = snapshotDiffCache.entries().next().value as
                | [string, { patch?: string; size?: number; binary: boolean; bytes: number }]
                | undefined
              if (!oldest) break
              snapshotDiffCache.delete(oldest[0])
              snapshotDiffCacheBytes -= oldest[1].bytes
            }
          }

          const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]
          let activeIndex: string | undefined

          const feed = (list: string[]) => list.join("\0") + "\0"

          const git = Effect.fnUntraced(
            function* (
              cmd: string[],
              opts?: { cwd?: string; env?: Record<string, string>; stdin?: string; timeout?: Duration.Input },
            ) {
              const result = yield* appProcess.run(
                ChildProcess.make("git", cmd, {
                  cwd: opts?.cwd,
                  env: {
                    ...opts?.env,
                    ...(activeIndex && (cmd.includes(state.gitdir) || opts?.env?.GIT_DIR === state.gitdir)
                      ? { GIT_INDEX_FILE: activeIndex }
                      : {}),
                  },
                  extendEnv: true,
                }),
                { stdin: opts?.stdin, timeout: opts?.timeout },
              )
              return {
                code: ChildProcessSpawner.ExitCode(result.exitCode),
                text: result.stdout.toString("utf8"),
                stderr: result.stderr.toString("utf8"),
              } satisfies GitResult
            },
            Effect.catch((err) =>
              Effect.succeed({
                code: ChildProcessSpawner.ExitCode(1),
                text: "",
                stderr: err instanceof Error ? err.message : String(err),
              }),
            ),
          )

          const requiredText = Effect.fnUntraced(function* (operation: string, result: GitResult) {
            if (result.code !== 0) {
              log.warn("snapshot diff git command failed", {
                operation,
                exitCode: result.code,
                stderr: result.stderr,
              })
              return yield* Effect.die(new Error(`snapshot diff ${operation} failed`))
            }
            return result.text
          })

          const ignore = Effect.fnUntraced(function* (files: string[]) {
            if (!files.length) return new Set<string>()
            const check = yield* git(
              [
                ...quote,
                "--git-dir",
                path.join(state.worktree, ".git"),
                "--work-tree",
                state.worktree,
                "check-ignore",
                "--no-index",
                "--stdin",
                "-z",
              ],
              {
                cwd: state.directory,
                stdin: feed(files),
              },
            )
            if (check.code !== 0 && check.code !== 1) return new Set<string>()
            return new Set(check.text.split("\0").filter(Boolean))
          })

          const drop = Effect.fnUntraced(function* (files: string[]) {
            if (!files.length) return
            const result = yield* git([...cfg, ...args(["update-index", "--force-remove", "-z", "--stdin"])], {
              cwd: state.directory,
              stdin: feed(files),
            })
            if (result.code !== 0) {
              log.warn("failed to remove snapshot files", { exitCode: result.code, stderr: result.stderr })
              return yield* new CaptureError({ operation: "drop" })
            }
          })

          const stage = Effect.fnUntraced(function* (files: string[]) {
            if (!files.length) return
            const result = yield* git(
              [...cfg, ...args(["update-index", "--add", "--remove", "--replace", "-z", "--stdin"])],
              {
                cwd: state.directory,
                stdin: feed(files),
              },
            )
            if (result.code === 0) return
            log.warn("failed to add snapshot files", {
              exitCode: result.code,
              stderr: result.stderr,
            })
            return yield* new CaptureError({ operation: "stage" })
          })

          const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
          const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
          const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
          const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
            lock(state.gitdir).withPermits(1)(
              Effect.gen(function* () {
                yield* Flock.effect(`snapshot:${state.gitdir}`)
                return yield* fx
              }).pipe(Effect.scoped),
            )

          // A killed writer may leave index.lock. Write through a private index
          // and only publish it after success, leaving the original index intact.
          const withTemporaryIndex = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                const index = `${state.gitdir}.index-${randomUUID()}`
                yield* fs.ensureDir(path.dirname(index)).pipe(Effect.orDie)
                const current = path.join(state.gitdir, "index")
                if (yield* exists(current)) yield* fs.copyFile(current, index).pipe(Effect.orDie)
                activeIndex = index
                log.info("snapshot temporary index prepared", { cwd: state.directory })
                return index
              }),
              (index) =>
                Effect.gen(function* () {
                  const result = yield* fx
                  if (yield* exists(index)) {
                    yield* fs
                      .rename(index, path.join(state.gitdir, "index"))
                      .pipe(Effect.retry({ times: 3, schedule: Schedule.spaced("20 millis") }), Effect.orDie)
                    log.info("snapshot temporary index installed", { cwd: state.directory })
                  }
                  return result
                }),
              (index) =>
                Effect.gen(function* () {
                  activeIndex = undefined
                  yield* remove(index)
                  yield* remove(`${index}.lock`)
                }),
            )

          const enabled = Effect.fnUntraced(function* () {
            if (state.vcs !== "git") return false
            return (yield* config.get()).snapshot !== false
          })

          const excludes = Effect.fnUntraced(function* () {
            const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
              cwd: state.worktree,
            })
            const file = result.text.trim()
            if (!file) return
            if (!(yield* exists(file))) return
            return file
          })

          const sync = Effect.fnUntraced(function* (list: string[] = []) {
            const file = yield* excludes()
            const target = path.join(state.gitdir, "info", "exclude")
            const text = [
              file ? (yield* read(file)).trimEnd() : "",
              ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
            ]
              .filter(Boolean)
              .join("\n")
            yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
            yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
          })

          const add = Effect.fnUntraced(function* () {
            yield* sync()
            const [diff, other] = yield* Effect.all(
              [
                git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                  cwd: state.directory,
                }),
                git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])], {
                  cwd: state.directory,
                }),
              ],
              { concurrency: 2 },
            )
            if (diff.code !== 0 || other.code !== 0) {
              log.warn("failed to list snapshot files", {
                diffCode: diff.code,
                diffStderr: diff.stderr,
                otherCode: other.code,
                otherStderr: other.stderr,
              })
              return yield* new CaptureError({ operation: "list" })
            }

            const tracked = diff.text.split("\0").filter(Boolean)
            const untracked = other.text.split("\0").filter(Boolean)
            const all = Array.from(new Set([...tracked, ...untracked]))
            if (!all.length) return

            // Resolve source-repo ignore rules against the exact candidate set.
            // --no-index keeps this pattern-based even when a path is already tracked.
            const ignored = yield* ignore(all)

            // Remove newly-ignored files from snapshot index to prevent re-adding
            if (ignored.size > 0) {
              const ignoredFiles = Array.from(ignored)
              log.info("removing gitignored files from snapshot", { count: ignoredFiles.length })
              yield* drop(ignoredFiles)
            }

            const allow = all.filter((item) => !ignored.has(item))
            if (!allow.length) return

            const large = new Set(
              (yield* Effect.all(
                allow.map((item) =>
                  fs
                    .stat(path.join(state.directory, item))
                    .pipe(Effect.catch(() => Effect.void))
                    .pipe(
                      Effect.map((stat) => {
                        if (!stat || stat.type !== "File") return
                        const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                        return size > limit ? item : undefined
                      }),
                    ),
                ),
                { concurrency: 8 },
              )).filter((item): item is string => Boolean(item)),
            )
            const block = new Set(untracked.filter((item) => large.has(item)))
            yield* sync(Array.from(block))
            // Stage only the allowed candidate paths so snapshot updates stay scoped.
            yield* stage(allow.filter((item) => !block.has(item)))
          })

          const cleanup = Effect.fnUntraced(function* () {
            return yield* locked(
              Effect.gen(function* () {
                if (!(yield* enabled())) return
                if (!(yield* exists(state.gitdir))) return
                const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
                if (result.code !== 0) {
                  log.warn("cleanup failed", {
                    exitCode: result.code,
                    stderr: result.stderr,
                  })
                  return
                }
                log.info("cleanup", { prune })
              }),
            )
          })

          const track = Effect.fnUntraced(function* () {
            return yield* locked(
              Effect.gen(function* () {
                if (!(yield* enabled())) return
                const initialized = yield* exists(path.join(state.gitdir, "HEAD"))
                yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
                if (!initialized) {
                  const initResult = yield* git(["init"], {
                    env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                  })
                  if (initResult.code !== 0) {
                    log.warn("snapshot initialization failed", {
                      exitCode: initResult.code,
                      stderr: initResult.stderr,
                    })
                    return yield* new CaptureError({ operation: "init" })
                  }
                  yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
                  yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
                  yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
                  yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
                  log.info("initialized")
                }
                yield* add()
                const result = yield* git(args(["write-tree"]), { cwd: state.directory })
                const hash = result.text.trim()
                if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(hash)) {
                  log.warn("snapshot tree capture failed", { exitCode: result.code, stderr: result.stderr })
                  return yield* new CaptureError({ operation: "write-tree" })
                }
                log.info("tracking", { hash, cwd: state.directory, git: state.gitdir })
                return hash
              }).pipe(withTemporaryIndex),
            ).pipe(
              Effect.catchTag("SnapshotCaptureError", (error) =>
                Effect.sync(() => {
                  log.warn("snapshot capture skipped", { operation: error.operation, cwd: state.directory })
                  return undefined
                }),
              ),
            )
          })

          const patch = Effect.fnUntraced(function* (hash: string) {
            return yield* locked(
              Effect.gen(function* () {
                yield* add()
                const result = yield* git(
                  [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", "-z", hash, "--", "."])],
                  {
                    cwd: state.directory,
                  },
                )
                if (result.code !== 0) {
                  log.warn("failed to get diff", { hash, exitCode: result.code })
                  return { hash, files: [] }
                }
                const files = result.text.split("\0").filter(Boolean)

                // Hide ignored-file removals from the user-facing patch output.
                const ignored = yield* ignore(files)

                return {
                  hash,
                  files: files
                    .filter((item) => !ignored.has(item))
                    .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
                }
              }).pipe(withTemporaryIndex),
            ).pipe(Effect.catchTag("SnapshotCaptureError", () => Effect.succeed({ hash, files: [] })))
          })

          const restore = Effect.fnUntraced(function* (snapshot: string) {
            return yield* locked(
              Effect.gen(function* () {
                log.info("restore", { commit: snapshot })
                const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
                if (result.code === 0) {
                  const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                    cwd: state.worktree,
                  })
                  if (checkout.code === 0) return
                  log.error("failed to restore snapshot", {
                    snapshot,
                    exitCode: checkout.code,
                    stderr: checkout.stderr,
                  })
                  return
                }
                log.error("failed to restore snapshot", {
                  snapshot,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
              }).pipe(withTemporaryIndex),
            )
          })

          const revert = Effect.fnUntraced(function* (patches: Patch[]) {
            return yield* locked(
              Effect.gen(function* () {
                const ops: { hash: string; file: string; rel: string }[] = []
                const seen = new Set<string>()
                for (const item of patches) {
                  for (const file of item.files) {
                    if (seen.has(file)) continue
                    seen.add(file)
                    ops.push({
                      hash: item.hash,
                      file,
                      rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                    })
                  }
                }

                const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                  log.info("reverting", { file: op.file, hash: op.hash })
                  const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                    cwd: state.worktree,
                  })
                  if (result.code === 0) return
                  const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                    cwd: state.worktree,
                  })
                  if (tree.code === 0 && tree.text.trim()) {
                    log.info("file existed in snapshot but checkout failed, keeping", { file: op.file, hash: op.hash })
                    return
                  }
                  log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                })

                const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

                for (let i = 0; i < ops.length; ) {
                  const first = ops[i]!
                  const run = [first]
                  let j = i + 1
                  // Only batch adjacent files when their paths cannot affect each other.
                  while (j < ops.length && run.length < 100) {
                    const next = ops[j]!
                    if (next.hash !== first.hash) break
                    if (run.some((item) => clash(item.rel, next.rel))) break
                    run.push(next)
                    j += 1
                  }

                  if (run.length === 1) {
                    yield* single(first)
                    i = j
                    continue
                  }

                  const tree = yield* git(
                    [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                    {
                      cwd: state.worktree,
                    },
                  )

                  if (tree.code !== 0) {
                    log.info("batched ls-tree failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: run.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }

                  const have = new Set(
                    tree.text
                      .trim()
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                  const list = run.filter((item) => have.has(item.rel))
                  if (list.length) {
                    log.info("reverting", { hash: first.hash, files: list.length })
                    const result = yield* git(
                      [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                      {
                        cwd: state.worktree,
                      },
                    )
                    if (result.code !== 0) {
                      log.info("batched checkout failed, falling back to single-file revert", {
                        hash: first.hash,
                        files: list.length,
                      })
                      for (const op of run) {
                        yield* single(op)
                      }
                      i = j
                      continue
                    }
                  }

                  for (const op of run) {
                    if (have.has(op.rel)) continue
                    log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                    yield* remove(op.file)
                  }

                  i = j
                }
              }).pipe(withTemporaryIndex),
            )
          })

          const diff = Effect.fnUntraced(function* (hash: string) {
            return yield* locked(
              Effect.gen(function* () {
                yield* add()
                const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                  cwd: state.worktree,
                })
                if (result.code !== 0) {
                  log.warn("failed to get diff", {
                    hash,
                    exitCode: result.code,
                    stderr: result.stderr,
                  })
                  return ""
                }
                return result.text.trim()
              }).pipe(withTemporaryIndex),
            ).pipe(Effect.catchTag("SnapshotCaptureError", () => Effect.succeed("")))
          })

          const diffFull = Effect.fnUntraced(function* (from: string, to: string, files?: ReadonlySet<string>) {
            return yield* locked(
              Effect.gen(function* () {
                if (files && files.size === 0) return []
                const started = performance.now()
                let snapshotCacheHits = 0
                type Row = {
                  file: string
                  status: "added" | "deleted" | "modified"
                  binary: boolean
                  additions: number
                  deletions: number
                }

                type Ref = {
                  file: string
                  side: "before" | "after"
                  ref: string
                }

                const show = Effect.fnUntraced(function* (row: Row) {
                  if (row.binary) return ["", ""]
                  if (row.status === "added") {
                    const result = yield* git([...cfg, ...args(["show", `${to}:${row.file}`])], {
                      timeout: Duration.seconds(30),
                    })
                    return ["", yield* requiredText("show", result)]
                  }
                  if (row.status === "deleted") {
                    const result = yield* git([...cfg, ...args(["show", `${from}:${row.file}`])], {
                      timeout: Duration.seconds(30),
                    })
                    return [yield* requiredText("show", result), ""]
                  }
                  const results = yield* Effect.all(
                    [
                      git([...cfg, ...args(["show", `${from}:${row.file}`])], { timeout: Duration.seconds(30) }),
                      git([...cfg, ...args(["show", `${to}:${row.file}`])], { timeout: Duration.seconds(30) }),
                    ],
                    { concurrency: 2 },
                  )
                  return [yield* requiredText("show", results[0]), yield* requiredText("show", results[1])]
                })

                const load = Effect.fnUntraced(
                  function* (rows: Row[]) {
                    const refs = rows.flatMap((row) => {
                      if (row.binary) return []
                      if (row.status === "added")
                        return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                      if (row.status === "deleted") {
                        return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                      }
                      return [
                        { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                        { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                      ]
                    })
                    if (!refs.length) return new Map<string, { before: string; after: string }>()

                    const batch = yield* appProcess.run(
                      ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                        cwd: state.directory,
                        extendEnv: true,
                      }),
                      { stdin: refs.map((item) => item.ref).join("\n") + "\n", timeout: Duration.seconds(30) },
                    )
                    if (batch.exitCode !== 0) {
                      log.info("git cat-file --batch failed during snapshot diff, falling back to per-file git show", {
                        stderr: batch.stderr.toString("utf8"),
                        refs: refs.length,
                      })
                      return
                    }
                    const out = batch.stdout

                    const fail = (msg: string, extra?: Record<string, string>) => {
                      log.info(msg, { ...extra, refs: refs.length })
                      return undefined
                    }

                    const map = new Map<string, { before: string; after: string }>()
                    const dec = new TextDecoder()
                    let i = 0
                    for (const ref of refs) {
                      let end = i
                      while (end < out.length && out[end] !== 10) end += 1
                      if (end >= out.length) {
                        return fail(
                          "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                        )
                      }

                      const head = dec.decode(out.slice(i, end))
                      i = end + 1
                      const hit = map.get(ref.file) ?? { before: "", after: "" }
                      if (head.endsWith(" missing")) {
                        return fail("git cat-file --batch returned a missing snapshot blob during snapshot diff")
                      }

                      const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                      if (!match) {
                        return fail(
                          "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                          { head },
                        )
                      }

                      const size = Number(match[1])
                      if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                        return fail(
                          "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                          { head },
                        )
                      }

                      const text = dec.decode(out.slice(i, i + size))
                      if (ref.side === "before") hit.before = text
                      if (ref.side === "after") hit.after = text
                      map.set(ref.file, hit)
                      i += size + 1
                    }

                    if (i !== out.length) {
                      return fail(
                        "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                      )
                    }

                    return map
                  },
                  Effect.scoped,
                  Effect.catch(() =>
                    Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                  ),
                )

                const result: FileDiff[] = []
                const status = new Map<string, "added" | "deleted" | "modified">()

                const statuses = yield* git(
                  [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                  { cwd: state.directory, timeout: Duration.seconds(30) },
                )
                yield* requiredText("name-status", statuses)

                for (const line of statuses.text.trim().split("\n")) {
                  if (!line) continue
                  const [code, rawFile] = line.split("\t")
                  const file = rawFile ? unquotePath(rawFile) : undefined
                  if (!code || !file) continue
                  status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
                }

                const numstat = yield* git(
                  [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                  {
                    cwd: state.directory,
                    timeout: Duration.seconds(30),
                  },
                )
                yield* requiredText("numstat", numstat)

                const rows = numstat.text
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .flatMap((line) => {
                    const [adds, dels, rawFile] = line.split("\t")
                    const file = rawFile ? unquotePath(rawFile) : undefined
                    if (!file) return []
                    const binary = adds === "-" && dels === "-"
                    const additions = binary ? 0 : parseInt(adds)
                    const deletions = binary ? 0 : parseInt(dels)
                    return [
                      {
                        file,
                        status: status.get(file) ?? "modified",
                        binary,
                        additions: Number.isFinite(additions) ? additions : 0,
                        deletions: Number.isFinite(deletions) ? deletions : 0,
                      } satisfies Row,
                    ]
                  })

                // Hide ignored-file removals from the user-facing diff output.
                const ignored = yield* ignore(rows.map((r) => r.file))
                if (ignored.size > 0) {
                  const filtered = rows.filter((r) => !ignored.has(r.file))
                  rows.length = 0
                  rows.push(...filtered)
                }
                if (files) {
                  const owned = new Set([...files].map((file) => path.resolve(file)))
                  for (let i = rows.length - 1; i >= 0; i--) {
                    if (!owned.has(path.resolve(state.worktree, rows[i]!.file))) rows.splice(i, 1)
                  }
                }

                const step = 100
                const snapshotDiffKey = (file: string) => `${from}\0${to}\0${file}\0git-full-v1`

                for (let i = 0; i < rows.length; i += step) {
                  const run = rows.slice(i, i + step)
                  const ready = new Map<string, FileDiff>()
                  const work = run.filter((row) => {
                    const key = snapshotDiffKey(row.file)
                    const cached = snapshotDiffCache.get(key)
                    if (!cached || cached.binary !== row.binary) {
                      if (cached) {
                        snapshotDiffCache.delete(key)
                        snapshotDiffCacheBytes -= cached.bytes
                      }
                      return true
                    }
                    snapshotDiffCache.delete(key)
                    snapshotDiffCache.set(key, cached)
                    snapshotCacheHits++
                    ready.set(row.file, {
                      file: row.file,
                      patch: cached.patch,
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                      ...(cached.size === undefined ? {} : { size: cached.size }),
                    })
                    return false
                  })
                  const text = work.length ? yield* load(work) : new Map<string, { before: string; after: string }>()
                  const contents = new Map(text ?? [])
                  if (!text && work.length) {
                    for (const row of work) {
                      if (row.binary) continue
                      const [before, after] = yield* show(row)
                      contents.set(row.file, { before, after })
                    }
                    log.info("snapshot diff content batch fallback", { from, to, files: work.length })
                  }
                  const patches = new Map<string, string>()
                  const cacheKeys = new Map<string, string>()
                  let cacheHits = 0
                  const patchRows = work.filter((row) => {
                    if (row.binary) return false
                    const hit = contents.get(row.file)
                    if (!hit) return false
                    if (Buffer.byteLength(hit.before) > limit || Buffer.byteLength(hit.after) > limit) return false
                    if (row.status === "modified" && hit.before === hit.after) return true
                    const key = patchKey(row.file, row.status, hit.before, hit.after)
                    cacheKeys.set(row.file, key)
                    const cached = patchCache.get(key)
                    if (cached) {
                      patchCache.delete(key)
                      patchCache.set(key, cached)
                      patches.set(row.file, cached.patch)
                      cacheHits++
                      return false
                    }
                    return true
                  })

                  if (patchRows.length) {
                    const started = performance.now()
                    const patchResult = yield* patchGeneration.withPermits(1)(
                      git(
                        [
                          ...quote,
                          ...args([
                            "--literal-pathspecs",
                            "diff",
                            "--no-ext-diff",
                            "--no-textconv",
                            "--no-renames",
                            "--no-prefix",
                            "--unified=2147483647",
                            from,
                            to,
                            "--",
                            ...patchRows.map((row) => row.file),
                          ]),
                        ],
                        { cwd: state.directory, timeout: Duration.seconds(30) },
                      ),
                    )
                    if (patchResult.code !== 0) {
                      log.warn("snapshot diff patch generation failed", {
                        from,
                        to,
                        files: patchRows.length,
                        exitCode: patchResult.code,
                        stderr: patchResult.stderr,
                      })
                      return yield* Effect.die(new Error("snapshot diff patch generation failed"))
                    }
                    const parsed = patchResult.text.split(/(?=^diff --git )/m).filter(Boolean)
                    const byFile = new Map(
                      parsed.flatMap((patch) => {
                        const file = gitPatchPath(patch)
                        return file ? [[file, patch] as const] : []
                      }),
                    )
                    for (const row of patchRows) {
                      const hit = contents.get(row.file)!
                      const patch = byFile.get(row.file)
                      if (patch !== undefined) {
                        patches.set(row.file, patch)
                        const key = cacheKeys.get(row.file)
                        if (key) rememberPatch(key, patch)
                        continue
                      }
                      if (hit.before === "" && hit.after === "") {
                        patches.set(row.file, "")
                        rememberPatch(cacheKeys.get(row.file)!, "")
                        continue
                      }
                      log.warn("snapshot diff patch missing for changed file", { from, to })
                      return yield* Effect.die(new Error("snapshot diff patch missing for changed file"))
                    }
                    log.info("snapshot diff patches generated", {
                      from,
                      to,
                      files: patchRows.length,
                      cacheHits,
                      bytes: Buffer.byteLength(patchResult.text),
                      elapsedMs: Math.round(performance.now() - started),
                    })
                  }

                  for (const row of work) {
                    const hit = contents.get(row.file) ?? { before: "", after: "" }
                    const [before, after] = row.binary ? ["", ""] : [hit.before, hit.after]
                    const size = row.binary ? undefined : Buffer.byteLength(row.status === "deleted" ? before : after)
                    const diff = {
                      file: row.file,
                      patch: row.binary ? "" : patches.get(row.file),
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                      ...(size === undefined ? {} : { size }),
                    } satisfies FileDiff
                    ready.set(row.file, diff)
                    rememberSnapshotDiff(snapshotDiffKey(row.file), { ...diff, binary: row.binary })
                  }
                  for (const row of run) result.push(ready.get(row.file)!)
                }

                log.info("snapshot diff completed", {
                  from,
                  to,
                  files: result.length,
                  cacheHits: snapshotCacheHits,
                  elapsedMs: Math.round(performance.now() - started),
                })
                return result
              }),
            )
          })

          yield* cleanup().pipe(
            Effect.catchCause((cause) => {
              log.error("cleanup loop failed", { cause: Cause.pretty(cause) })
              return Effect.void
            }),
            Effect.repeat(Schedule.spaced(Duration.hours(1))),
            Effect.delay(Duration.minutes(1)),
            Effect.forkScoped,
          )

          return { cleanup, track, patch, restore, revert, diff, diffFull }
        }),
      )

      return Service.of({
        init: Effect.fn("Snapshot.init")(function* () {
          yield* InstanceState.get(state)
        }),
        cleanup: Effect.fn("Snapshot.cleanup")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.cleanup())
        }),
        track: Effect.fn("Snapshot.track")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.track())
        }),
        patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
          return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
        }),
        restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
          return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
        }),
        revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
          return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
        }),
        diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
          return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
        }),
        diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string, files?: ReadonlySet<string>) {
          return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to, files))
        }),
      })
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Snapshot from "."
