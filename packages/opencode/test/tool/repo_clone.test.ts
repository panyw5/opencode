import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "node:url"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Git } from "../../src/git"
import { MessageID, SessionID } from "../../src/session/schema"
import { Truncate } from "../../src/tool/truncate"
import { RepoCloneTool } from "../../src/tool/repo_clone"
import { RepositoryCache } from "../../src/reference/repository-cache"
import {
  parseRemoteRepositoryReference,
  repositoryCachePath,
  repositoryLegacyCachePath,
} from "../../src/util/repository"
import { disposeAllInstances, provideTmpdirInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "scout",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Git.defaultLayer,
    RepositoryCache.defaultLayer,
    Truncate.defaultLayer,
  ),
)

const init = Effect.fn("RepoCloneToolTest.init")(function* () {
  const info = yield* RepoCloneTool
  return yield* info.init()
})

const git = Effect.fn("RepoCloneToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) {
      throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    }
    return stdout.trim()
  })
})

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )

describe("tool.repo_clone", () => {
  it.live("clones a repo into the managed cache and reuses it on subsequent calls", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const remoteDir = path.join(remoteRoot, "owner")
        const remoteRepo = path.join(remoteDir, "repo.git")

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "v1\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add readme"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])
        yield* git(remoteRepo, ["symbolic-ref", "HEAD", "refs/heads/main"])

        const reference = parseRemoteRepositoryReference("owner/repo")
        const canonical = repositoryCachePath(reference)
        const legacy = repositoryLegacyCachePath(reference)
        yield* fs.remove(canonical, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* fs.remove(legacy, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [canonical, legacy],
            (target) => fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore),
            { discard: true },
          ),
        )

        const tool = yield* init()
        const cloned = yield* githubBase(`file://${remoteRoot}/`, tool.execute({ repository: "owner/repo" }, ctx))
        const cached = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository: "https://github.com/owner/repo.git" }, ctx),
        )

        expect(cloned.metadata.status).toBe("cloned")
        expect(cloned.metadata.localPath).toBe(canonical)
        expect(cached.metadata.status).toBe("cached")
        expect(yield* fs.readFileString(path.join(cloned.metadata.localPath, "README.md"))).toBe("v1\n")

        yield* fs.ensureDir(path.dirname(legacy))
        yield* fs.rename(canonical, legacy)
        const migrated = yield* githubBase(`file://${remoteRoot}/`, tool.execute({ repository: "owner/repo" }, ctx))
        expect(migrated.metadata.status).toBe("cached")
        expect(migrated.metadata.localPath).toBe(canonical)
        expect(yield* fs.existsSafe(legacy)).toBe(false)
      }),
    ),
  )

  it.live("refresh updates an existing cached clone", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const remoteDir = path.join(remoteRoot, "owner")
        const remoteRepo = path.join(remoteDir, "repo.git")

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "v1\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add readme"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])

        const branch = yield* git(source, ["branch", "--show-current"])
        yield* git(source, ["remote", "add", "origin", remoteRepo])
        yield* git(source, ["push", "-u", "origin", `${branch}:${branch}`])

        const tool = yield* init()
        const first = yield* githubBase(`file://${remoteRoot}/`, tool.execute({ repository: "owner/repo" }, ctx))

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "v2\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "update readme"])
        yield* git(source, ["push", "origin", `${branch}:${branch}`])

        const refreshed = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository: "owner/repo", refresh: true }, ctx),
        )

        expect(first.metadata.status).toBe("cloned")
        expect(refreshed.metadata.status).toBe("refreshed")
        expect(yield* fs.readFileString(path.join(first.metadata.localPath, "README.md"))).toBe("v2\n")
      }),
    ),
  )

  it.live("clones a configured branch", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const remoteDir = path.join(remoteRoot, "owner")
        const remoteRepo = path.join(remoteDir, "repo.git")

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "main\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add readme"])
        yield* git(source, ["checkout", "-b", "docs"])
        yield* Effect.promise(() => Bun.write(path.join(source, "DOCS.md"), "docs\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "add docs"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])
        yield* git(remoteRepo, ["symbolic-ref", "HEAD", "refs/heads/main"])

        const tool = yield* init()
        const result = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository: "owner/repo", branch: "docs" }, ctx),
        )

        expect(result.metadata.status).toBe("cloned")
        expect(result.metadata.branch).toBe("docs")
        expect(result.metadata.localPath).toBe(
          repositoryCachePath(parseRemoteRepositoryReference("owner/repo"), "docs"),
        )
        expect(yield* fs.readFileString(path.join(result.metadata.localPath, "DOCS.md"))).toBe("docs\n")
      }),
    ),
  )

  it.live("keeps branch checkouts isolated from the branchless cache", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const remoteDir = path.join(remoteRoot, "branch-isolation-owner")
        const remoteRepo = path.join(remoteDir, "branch-isolation-repo.git")

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "main\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "main"])
        yield* git(source, ["checkout", "-b", "feature/docs"])
        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "feature\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "feature"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])
        yield* git(remoteRepo, ["symbolic-ref", "HEAD", "refs/heads/main"])

        const tool = yield* init()
        const main = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository: "branch-isolation-owner/branch-isolation-repo" }, ctx),
        )
        const feature = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute(
            { repository: "branch-isolation-owner/branch-isolation-repo", branch: "feature/docs" },
            ctx,
          ),
        )

        expect(main.metadata.localPath).not.toBe(feature.metadata.localPath)
        expect(feature.metadata.localPath).toBe(
          repositoryCachePath(
            parseRemoteRepositoryReference("branch-isolation-owner/branch-isolation-repo"),
            "feature/docs",
          ),
        )
        expect(yield* fs.readFileString(path.join(main.metadata.localPath, "README.md"))).toBe("main\n")
        expect(yield* fs.readFileString(path.join(feature.metadata.localPath, "README.md"))).toBe("feature\n")
      }),
    ),
  )

  it.live("migrates a matching legacy branch cache path without recloning", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const repository = "migration-owner/migration-repo"
        const remoteDir = path.join(remoteRoot, "migration-owner")
        const remoteRepo = path.join(remoteDir, "migration-repo.git")

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "main\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "main"])
        yield* git(source, ["checkout", "-b", "docs"])
        yield* Effect.promise(() => Bun.write(path.join(source, "DOCS.md"), "docs\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "docs"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])
        yield* git(remoteRepo, ["symbolic-ref", "HEAD", "refs/heads/main"])

        const reference = parseRemoteRepositoryReference(repository)
        const current = repositoryCachePath(reference, "docs")
        const legacy = repositoryLegacyCachePath(reference, "docs")
        yield* fs.remove(current, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* fs.remove(legacy, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [current, legacy],
            (target) => fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore),
            { discard: true },
          ),
        )

        const tool = yield* init()
        const first = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository, branch: "docs" }, ctx),
        )
        expect(first.metadata.status).toBe("cloned")
        yield* fs.ensureDir(path.dirname(legacy))
        yield* fs.rename(current, legacy)

        const migrated = yield* githubBase(
          `file://${remoteRoot}/`,
          Effect.all([1, 2].map(() => tool.execute({ repository, branch: "docs" }, ctx)), {
            concurrency: "unbounded",
          }),
        )
        expect(migrated.map((item) => item.metadata.status)).toEqual(["cached", "cached"])
        expect(migrated.map((item) => item.metadata.localPath)).toEqual([current, current])
        expect(yield* fs.existsSafe(legacy)).toBe(false)
        expect(yield* fs.existsSafe(path.join(current, ".git"))).toBe(true)

        yield* fs.ensureDir(path.dirname(legacy))
        yield* fs.rename(current, legacy)
        yield* git(legacy, ["checkout", "-B", "main"])
        const wrongBranch = yield* githubBase(
          `file://${remoteRoot}/`,
          tool.execute({ repository, branch: "docs" }, ctx),
        )
        expect(wrongBranch.metadata.status).toBe("cloned")
        expect(yield* fs.readFileString(path.join(current, "DOCS.md"))).toBe("docs\n")
        expect(yield* git(legacy, ["branch", "--show-current"])).toBe("main")
      }),
    ),
  )

  it.live("does not migrate a colliding legacy path owned by another repository", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const collisionSource = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const ownerDir = path.join(remoteRoot, "collision-owner")
        const remoteRepo = path.join(ownerDir, "repo.git")
        const collisionRepo = path.join(ownerDir, "repo@main.git")
        const reference = parseRemoteRepositoryReference("collision-owner/repo")
        const branchlessReference = parseRemoteRepositoryReference("collision-owner/repo@main")
        const current = repositoryCachePath(reference, "main")
        const branchlessCurrent = repositoryCachePath(branchlessReference)
        const legacy = repositoryLegacyCachePath(reference, "main")

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "target\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "target"])
        yield* Effect.promise(() => Bun.write(path.join(collisionSource, "README.md"), "collision\n"))
        yield* git(collisionSource, ["add", "."])
        yield* git(collisionSource, ["commit", "-m", "collision"])
        yield* fs.makeDirectory(ownerDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])
        yield* git(remoteRoot, ["clone", "--bare", collisionSource, collisionRepo])
        yield* git(remoteRepo, ["symbolic-ref", "HEAD", "refs/heads/main"])
        yield* git(collisionRepo, ["symbolic-ref", "HEAD", "refs/heads/main"])

        yield* fs.remove(current, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* fs.remove(branchlessCurrent, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* fs.remove(legacy, { recursive: true, force: true }).pipe(Effect.ignore)
        yield* fs.ensureDir(path.dirname(legacy))
        yield* git(path.dirname(legacy), ["clone", pathToFileURL(collisionRepo).href, legacy])
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            [current, branchlessCurrent, legacy],
            (target) => fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore),
            { discard: true },
          ),
        )

        const tool = yield* init()
        const [result, branchless] = yield* githubBase(
          `file://${remoteRoot}/`,
          Effect.all(
            [
              tool.execute({ repository: "collision-owner/repo", branch: "main" }, ctx),
              tool.execute({ repository: "collision-owner/repo@main" }, ctx),
            ],
            { concurrency: "unbounded" },
          ),
        )

        expect(result.metadata.status).toBe("cloned")
        expect(result.metadata.localPath).toBe(current)
        expect(branchless.metadata.status).toBe("cached")
        expect(branchless.metadata.localPath).toBe(branchlessCurrent)
        expect(yield* fs.readFileString(path.join(current, "README.md"))).toBe("target\n")
        expect(yield* fs.readFileString(path.join(branchlessCurrent, "README.md"))).toBe("collision\n")
        expect(yield* fs.existsSafe(legacy)).toBe(false)
      }),
    ),
  )

  it.live("serializes concurrent refreshes for one branch checkout", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const source = yield* tmpdirScoped({ git: true })
        const remoteRoot = yield* tmpdirScoped()
        const remoteDir = path.join(remoteRoot, "concurrent-owner")
        const remoteRepo = path.join(remoteDir, "concurrent-repo.git")

        yield* Effect.promise(() => Bun.write(path.join(source, "README.md"), "stable\n"))
        yield* git(source, ["add", "."])
        yield* git(source, ["commit", "-m", "stable"])
        yield* git(source, ["checkout", "-b", "feature/concurrent"])
        yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
        yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])

        const tool = yield* init()
        const repository = "concurrent-owner/concurrent-repo"
        const first = yield* githubBase(`file://${remoteRoot}/`, tool.execute({ repository, branch: "feature/concurrent" }, ctx))
        const results = yield* githubBase(
          `file://${remoteRoot}/`,
          Effect.all(
            [1, 2].map(() => tool.execute({ repository, branch: "feature/concurrent", refresh: true }, ctx)),
            { concurrency: "unbounded" },
          ),
        )

        expect(first.metadata.localPath).toBe(results[0].metadata.localPath)
        expect(results[0].metadata.localPath).toBe(results[1].metadata.localPath)
        expect(yield* fs.readFileString(path.join(first.metadata.localPath, "README.md"))).toBe("stable\n")
      }),
    ),
  )

  it.live("rejects invalid repository inputs", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const tool = yield* init()
        const inputs = [
          { repository: "not-a-repo", message: "git URL" },
          { repository: "git@github.com:../../../etc/passwd", message: "git URL" },
          { repository: "-u:foo/bar", message: "git URL" },
          { repository: pathToFileURL(path.join(_dir, "local.git")).href, message: "Local file" },
        ]

        yield* Effect.forEach(
          inputs,
          (input) =>
            Effect.gen(function* () {
              const result = yield* tool.execute({ repository: input.repository }, ctx).pipe(Effect.exit)

              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) {
                const error = Cause.squash(result.cause)
                expect(error instanceof Error ? error.message : String(error)).toContain(input.message)
              }
            }),
          { discard: true },
        )
      }),
    ),
  )

  it.live("rejects local file repository URLs", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const source = yield* tmpdirScoped({ git: true })
        const tool = yield* init()
        const result = yield* tool.execute({ repository: pathToFileURL(source).href }, ctx).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause)
          expect(error instanceof Error ? error.message : String(error)).toContain("Local file")
        }
      }),
    ),
  )

  it.live("rejects invalid branch inputs", () =>
    provideTmpdirInstance((_dir) =>
      Effect.gen(function* () {
        const tool = yield* init()
        const result = yield* tool.execute({ repository: "owner/repo", branch: "bad..branch" }, ctx).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause)
          expect(error instanceof Error ? error.message : String(error)).toContain(
            "Branch must contain only alphanumeric characters",
          )
        }
      }),
    ),
  )
})
