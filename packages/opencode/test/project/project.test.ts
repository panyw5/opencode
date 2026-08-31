import { describe, expect, test } from "bun:test"
import { Bus } from "@/bus"
import { Project } from "@/project/project"
import * as Log from "@opencode-ai/core/util/log"
import { $ } from "bun"
import path from "path"
import { tmpdirScoped } from "../fixture/fixture"
import { GlobalBus } from "../../src/bus/global"
import { ProjectID } from "../../src/project/schema"
import { Cause, Effect, Exit, Layer, Schema, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { NodePath } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProjectAlias } from "@/project/alias"
import { Database } from "@/storage/db"
import { ProjectTable } from "@/project/project.sql"

void Log.init({ print: false })

const encoder = new TextEncoder()

const layer = Layer.mergeAll(Project.defaultLayer, CrossSpawnSpawner.defaultLayer)
const it = testEffect(layer)

function run<A, E>(fn: (svc: Project.Interface) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const svc = yield* Project.Service
    return yield* fn(svc)
  })
}

/**
 * Creates a mock ChildProcessSpawner layer that intercepts git subcommands
 * matching `failArg` and returns exit code 128. The other probes return the
 * minimum deterministic output needed to reach the selected failure.
 */
function mockGitFailure(failArg: string) {
  const handle = (code: number, text = "", stderr = "") =>
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(0),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: text ? Stream.make(encoder.encode(text)) : Stream.empty,
      stderr: stderr ? Stream.make(encoder.encode(stderr)) : Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    })

  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(
      Effect.fnUntraced(function* (command) {
        const std = ChildProcess.isStandardCommand(command) ? command : undefined
        if (std?.command !== "git") throw new Error(`Unexpected command: ${std?.command ?? command._tag}`)
        if (std.args.some((arg) => arg === failArg)) return handle(128, "", "fatal: simulated failure\n")
        if (std.args.includes("--git-common-dir")) return handle(0, ".git\n")
        if (std.args.includes("core.bare")) return handle(0, "false\n")
        if (std.args.includes("remote")) return handle(2)
        if (std.args.includes("rev-list")) return handle(0, `${"a".repeat(40)}\n`)
        if (std.args.includes("--show-toplevel")) return handle(0, "/tmp/project\n")
        throw new Error(`Unexpected git arguments: ${std.args.join(" ")}`)
      }),
    ),
  )
}

function projectLayerWithFailure(failArg: string) {
  return Project.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        mockGitFailure(failArg),
        Bus.defaultLayer,
        AppFileSystem.defaultLayer,
        NodePath.layer,
        RuntimeFlags.defaultLayer,
      ),
    ),
  )
}

function projectLayerWithRuntimeFlags(flags: Parameters<typeof RuntimeFlags.layer>[0]) {
  return Project.layer.pipe(
    Layer.provide(Bus.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(NodePath.layer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )
}

const failureIt = (failArg: string) =>
  testEffect(Layer.mergeAll(projectLayerWithFailure(failArg), CrossSpawnSpawner.defaultLayer))

const iconDiscoveryIt = testEffect(
  Layer.provideMerge(projectLayerWithRuntimeFlags({ experimentalIconDiscovery: true }), CrossSpawnSpawner.defaultLayer),
)

function waitForProjectIcon(id: ProjectID, attempts = 50): Effect.Effect<Project.Info> {
  return Effect.gen(function* () {
    const project = Project.get(id)
    if (project?.icon?.url) return project
    if (attempts <= 0) throw new Error(`Project icon was not discovered: ${id}`)
    yield* Effect.sleep("10 millis")
    return yield* waitForProjectIcon(id, attempts - 1)
  })
}

describe("Project.fromDirectory", () => {
  test("fromRow omits nullable optional fields for HTTP response encoding", () => {
    const project = Project.fromRow({
      id: ProjectID.global,
      worktree: "/",
      vcs: null,
      name: null,
      icon_url: null,
      icon_url_override: null,
      icon_color: null,
      time_created: 1,
      time_updated: 2,
      time_initialized: null,
      sandboxes: [],
      commands: null,
    })

    expect("vcs" in project).toBe(false)
    expect("name" in project).toBe(false)
    expect("icon" in project).toBe(false)
    expect("commands" in project).toBe(false)
    expect("initialized" in project.time).toBe(false)
    expect(Schema.decodeUnknownSync(Project.Info)(project)).toEqual(project)
  })

  it.live("should handle git repository with no commits", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())

      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      expect(project).toBeDefined()
      expect(project.id).toStartWith("dir:")
      expect(project.vcs).toBe("git")
      expect(project.worktree).toBe(tmp)

      const opencodeFile = path.join(tmp, ".git", "opencode")
      expect(yield* Effect.promise(() => Bun.file(opencodeFile).text())).toBe(project.id)
    }),
  )

  it.live("should handle git repository with commits", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      expect(project).toBeDefined()
      expect(project.id).not.toBe(ProjectID.global)
      expect(project.vcs).toBe("git")
      expect(project.worktree).toBe(tmp)

      const opencodeFile = path.join(tmp, ".git", "opencode")
      expect(yield* Effect.promise(() => Bun.file(opencodeFile).exists())).toBe(true)
    }),
  )

  it.live("uses a stable directory project for non-git directories", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { project: a, location: firstLocation } = yield* run((svc) => svc.fromDirectory(tmp))
      const { project: b, location: secondLocation } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(a.id).toStartWith("dir:")
      expect(a.id).not.toBe(ProjectID.global)
      expect(b.id).toBe(a.id)
      expect(a.worktree).toBe(tmp)
      expect(a.vcs).toBeUndefined()
      expect("vcs" in a).toBe(false)
      expect(secondLocation.id).toBe(firstLocation.id)
      expect(firstLocation.projectID).toBe(a.id)
      expect(firstLocation.kind).toBe("directory")
      expect(firstLocation.vcsState).toBe("none")
      expect(Schema.encodeUnknownSync(Project.Info)(a)).toEqual(a)
    }),
  )

  it.live("isolates separate non-git directories", () =>
    Effect.gen(function* () {
      const first = yield* tmpdirScoped()
      const second = yield* tmpdirScoped()
      const { project: a } = yield* run((svc) => svc.fromDirectory(first))
      const { project: b } = yield* run((svc) => svc.fromDirectory(second))

      expect(a.id).toStartWith("dir:")
      expect(b.id).toStartWith("dir:")
      expect(a.id).not.toBe(b.id)
      expect(a.worktree).toBe(first)
      expect(b.worktree).toBe(second)
    }),
  )

  it.live("keeps a non-git project ID through git init and the first commit", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { project: before, location: beforeLocation } = yield* run((svc) => svc.fromDirectory(tmp))

      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())
      const { project: unborn, location: unbornLocation } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(unborn.id).toBe(before.id)
      expect(unborn.vcs).toBe("git")
      expect(unbornLocation.id).toBe(beforeLocation.id)
      expect(unbornLocation.vcsState).toBe("unborn")
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp, ".git", "opencode")).text())).toBe(before.id)

      yield* Effect.promise(() => $`git config commit.gpgsign false`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config user.email test@opencode.test`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config user.name Test`.cwd(tmp).quiet())
      yield* Effect.promise(() => Bun.write(path.join(tmp, "README.md"), "stable identity\n"))
      yield* Effect.promise(() => $`git add README.md`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git commit -m initial`.cwd(tmp).quiet())
      const { project: committed, location: committedLocation } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(committed.id).toBe(before.id)
      expect(committed.vcs).toBe("git")
      expect(committedLocation.id).toBe(beforeLocation.id)
      expect(committedLocation.vcsState).toBe("ready")
    }),
  )

  it.live("keeps directory identity when git metadata is removed", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const { project: before, location: beforeLocation } = yield* run((svc) => svc.fromDirectory(tmp))
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())
      const { project: git, location: gitLocation } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(git.id).toBe(before.id)
      expect(gitLocation.id).toBe(beforeLocation.id)

      yield* Effect.promise(() => $`rm -rf .git`.cwd(tmp).quiet())
      const { project: after, location: afterLocation } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(after.id).toBe(before.id)
      expect(after.vcs).toBeUndefined()
      expect(afterLocation.id).toBe(beforeLocation.id)
      expect(afterLocation.vcsState).toBe("none")
    }),
  )

  it.live("uses an opaque stable project ID while recording root evidence", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project: a } = yield* run((svc) => svc.fromDirectory(tmp))
      const { project: b } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(a.id).toStartWith("project_")
      expect(b.id).toBe(a.id)
      const root = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(tmp).text())).trim()
      expect(ProjectAlias.listByProject(a.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "root_commit", value: root, confidence: "low" })]),
      )
    }),
  )

  it.live("reuses an existing legacy root-hash project without rewriting its ID", () =>
    Effect.gen(function* () {
      const source = yield* tmpdirScoped({ git: true })
      const clone = source + "-legacy-root-clone"
      yield* Effect.addFinalizer(() => Effect.promise(() => $`rm -rf ${clone}`.quiet().nothrow()).pipe(Effect.ignore))
      const root = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(source).text())).trim()
      const legacyID = ProjectID.make(root)
      const now = Date.now()
      Database.use((db) =>
        db
          .insert(ProjectTable)
          .values({
            id: legacyID,
            worktree: `/legacy/${root}`,
            sandboxes: [],
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
      yield* Effect.promise(() => $`git clone ${source} ${clone}`.quiet())

      const resolved = yield* run((svc) => svc.fromDirectory(clone))

      expect(resolved.project.id).toBe(legacyID)
      expect(resolved.location.projectID).toBe(legacyID)
    }),
  )

  it.live("keeps project and location IDs stable across a history rewrite", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const before = yield* run((svc) => svc.fromDirectory(tmp))
      const originalRoot = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(tmp).text())).trim()

      yield* Effect.promise(() => $`git checkout --orphan rewritten-${Date.now()}`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git rm -rf .`.cwd(tmp).quiet().nothrow())
      yield* Effect.promise(() => Bun.write(path.join(tmp, "REWRITTEN.md"), "rewritten history\n"))
      yield* Effect.promise(() => $`git add REWRITTEN.md`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git commit -m rewritten`.cwd(tmp).quiet())

      const after = yield* run((svc) => svc.fromDirectory(tmp))
      const rewrittenRoot = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(tmp).text())).trim()

      expect(after.project.id).toBe(before.project.id)
      expect(after.location.id).toBe(before.location.id)
      expect(rewrittenRoot).not.toBe(originalRoot)
      expect(ProjectAlias.listByProject(before.project.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "root_commit", value: originalRoot }),
          expect.objectContaining({ kind: "root_commit", value: rewrittenRoot }),
        ]),
      )
    }),
  )

  it.live("keeps project and location IDs stable when a shallow clone is deepened", () =>
    Effect.gen(function* () {
      const source = yield* tmpdirScoped({ git: true })
      yield* Effect.promise(() => Bun.write(path.join(source, "second.txt"), "second\n"))
      yield* Effect.promise(() => $`git add second.txt`.cwd(source).quiet())
      yield* Effect.promise(() => $`git commit -m second`.cwd(source).quiet())
      const clone = source + "-shallow"
      yield* Effect.addFinalizer(() => Effect.promise(() => $`rm -rf ${clone}`.quiet().nothrow()).pipe(Effect.ignore))
      yield* Effect.promise(() => $`git clone --depth 1 ${`file://${source}`} ${clone}`.quiet())

      const before = yield* run((svc) => svc.fromDirectory(clone))
      const shallowRoot = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(clone).text())).trim()
      yield* Effect.promise(() => $`git fetch --unshallow`.cwd(clone).quiet())
      const after = yield* run((svc) => svc.fromDirectory(clone))
      const fullRoot = (yield* Effect.promise(() => $`git rev-list --max-parents=0 HEAD`.cwd(clone).text())).trim()

      expect(after.project.id).toBe(before.project.id)
      expect(after.location.id).toBe(before.location.id)
      expect(fullRoot).not.toBe(shallowRoot)
      expect(ProjectAlias.listByProject(before.project.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "root_commit", value: shallowRoot }),
          expect.objectContaining({ kind: "root_commit", value: fullRoot }),
        ]),
      )
    }),
  )
})

describe("Project.fromDirectory git failure paths", () => {
  it.live("keeps vcs when rev-list exits non-zero (no commits)", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())

      // rev-list fails because HEAD doesn't exist yet: this is the natural scenario.
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(project.vcs).toBe("git")
      expect(project.id).toStartWith("dir:")
      expect(project.worktree).toBe(tmp)
    }),
  )

  failureIt("--show-toplevel").live("handles show-toplevel failure gracefully", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(tmp)
    }),
  )

  failureIt("--git-common-dir").live("handles git-common-dir failure gracefully", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(tmp))
      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(tmp)
    }),
  )

  failureIt("--git-common-dir").live("keeps a linked worktree identity when git-common-dir fails", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const expected = ProjectID.make(`dir:${"b".repeat(40)}`)
      yield* Effect.promise(() => Bun.write(path.join(tmp, ".git", "opencode"), expected))
      const worktree = path.join(tmp, "..", `${path.basename(tmp)}-common-dir-failure`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`git worktree remove ${worktree}`.cwd(tmp).quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git worktree add ${worktree} -b common-dir-failure-${Date.now()}`.cwd(tmp).quiet())

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(worktree))
      expect(project.id).toBe(expected)
      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(worktree)
    }),
  )
})

describe("Project.fromDirectory with worktrees", () => {
  it.live("should set worktree to root when called from root", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(tmp))

      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(tmp)
      expect(project.sandboxes).not.toContain(tmp)
    }),
  )

  it.live("should set worktree to root when called from a worktree", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const worktreePath = path.join(tmp, "..", path.basename(tmp) + "-worktree")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove ${worktreePath}`
            .cwd(tmp)
            .quiet()
            .catch(() => {}),
        ),
      )
      yield* Effect.promise(() => $`git worktree add ${worktreePath} -b test-branch-${Date.now()}`.cwd(tmp).quiet())

      const { project, sandbox } = yield* run((svc) => svc.fromDirectory(worktreePath))

      expect(project.worktree).toBe(tmp)
      expect(sandbox).toBe(worktreePath)
      expect(project.sandboxes).toContain(worktreePath)
      expect(project.sandboxes).not.toContain(tmp)
    }),
  )

  it.live("worktree should share project ID with main repo", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const { project: main, location: mainLocation } = yield* run((svc) => svc.fromDirectory(tmp))

      const worktreePath = path.join(tmp, "..", path.basename(tmp) + "-wt-shared")
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          $`git worktree remove ${worktreePath}`
            .cwd(tmp)
            .quiet()
            .catch(() => {}),
        ),
      )
      yield* Effect.promise(() => $`git worktree add ${worktreePath} -b shared-${Date.now()}`.cwd(tmp).quiet())

      const { project: wt, location: worktreeLocation } = yield* run((svc) => svc.fromDirectory(worktreePath))

      expect(wt.id).toBe(main.id)
      expect(worktreeLocation.id).not.toBe(mainLocation.id)
      expect(mainLocation.kind).toBe("git_main")
      expect(worktreeLocation.kind).toBe("git_worktree")

      // Cache should live in the common .git dir, not the worktree's .git file
      const cache = path.join(tmp, ".git", "opencode")
      const exists = yield* Effect.promise(() => Bun.file(cache).exists())
      expect(exists).toBe(true)
    }),
  )

  it.live("separate local clones default to different projects and locations", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      // Create a bare remote, push, then clone into a second directory
      const bare = tmp + "-bare"
      const clone = tmp + "-clone"
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bare} ${clone}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git clone --bare ${tmp} ${bare}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${clone}`.quiet())

      const { project: a, location: locationA } = yield* run((svc) => svc.fromDirectory(tmp))
      const { project: b, location: locationB } = yield* run((svc) => svc.fromDirectory(clone))

      expect(b.id).not.toBe(a.id)
      expect(locationB.id).not.toBe(locationA.id)
    }),
  )

  it.live("associates clones when one normalized remote alias identifies a unique project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const bare = tmp + "-remote-bare"
      const firstClone = tmp + "-remote-first"
      const secondClone = tmp + "-remote-second"
      const remote = `https://example.com/org/repository-${crypto.randomUUID()}.git`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bare} ${firstClone} ${secondClone}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git clone --bare ${tmp} ${bare}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${firstClone}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${secondClone}`.quiet())
      yield* Effect.promise(() => $`git remote set-url origin ${remote}`.cwd(firstClone).quiet())
      yield* Effect.promise(() => $`git remote set-url origin ${remote}`.cwd(secondClone).quiet())

      const first = yield* run((svc) => svc.fromDirectory(firstClone))
      const second = yield* run((svc) => svc.fromDirectory(secondClone))

      expect(second.project.id).toBe(first.project.id)
      expect(second.location.id).not.toBe(first.location.id)
      expect(first.location.kind).toBe("git_clone")
      expect(second.location.kind).toBe("git_clone")
      expect(second.project.worktree).toBe(first.project.worktree)
      expect(second.project.sandboxes).toContain(second.location.directory)
    }),
  )

  it.live("does not associate a clone when its normalized remote has multiple project candidates", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const bare = tmp + "-ambiguous-bare"
      const firstClone = tmp + "-ambiguous-first"
      const secondClone = tmp + "-ambiguous-second"
      const remote = `https://example.com/org/ambiguous-${crypto.randomUUID()}.git`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bare} ${firstClone} ${secondClone}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => $`git clone --bare ${tmp} ${bare}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${firstClone}`.quiet())
      yield* Effect.promise(() => $`git clone ${bare} ${secondClone}`.quiet())
      yield* Effect.promise(() => $`git remote set-url origin ${remote}`.cwd(firstClone).quiet())
      yield* Effect.promise(() => $`git remote set-url origin ${remote}`.cwd(secondClone).quiet())

      const first = yield* run((svc) => svc.fromDirectory(firstClone))
      const otherProjectID = ProjectID.ascending()
      const now = Date.now()
      Database.use((db) =>
        db
          .insert(ProjectTable)
          .values({
            id: otherProjectID,
            worktree: `/tmp/${otherProjectID}`,
            sandboxes: [],
            time_created: now,
            time_updated: now,
          })
          .run(),
      )
      const normalized = ProjectAlias.normalizeRemoteUrl(remote)
      if (!normalized) throw new Error("test remote did not normalize")
      ProjectAlias.upsert({
        projectID: otherProjectID,
        kind: "remote_url",
        value: normalized,
        confidence: "medium",
      })

      const second = yield* run((svc) => svc.fromDirectory(secondClone))

      expect(second.project.id).not.toBe(first.project.id)
      expect(second.project.id).not.toBe(otherProjectID)
    }),
  )

  it.live("should accumulate multiple worktrees in sandboxes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const worktree1 = path.join(tmp, "..", path.basename(tmp) + "-wt1")
      const worktree2 = path.join(tmp, "..", path.basename(tmp) + "-wt2")
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            $`git worktree remove ${worktree1}`
              .cwd(tmp)
              .quiet()
              .catch(() => {}),
          )
          yield* Effect.promise(() =>
            $`git worktree remove ${worktree2}`
              .cwd(tmp)
              .quiet()
              .catch(() => {}),
          )
        }),
      )
      yield* Effect.promise(() => $`git worktree add ${worktree1} -b branch-${Date.now()}`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git worktree add ${worktree2} -b branch-${Date.now() + 1}`.cwd(tmp).quiet())

      yield* run((svc) => svc.fromDirectory(worktree1))
      const { project } = yield* run((svc) => svc.fromDirectory(worktree2))

      expect(project.worktree).toBe(tmp)
      expect(project.sandboxes).toContain(worktree1)
      expect(project.sandboxes).toContain(worktree2)
      expect(project.sandboxes).not.toContain(tmp)
    }),
  )
})

describe("Project.discover", () => {
  iconDiscoveryIt.live("discovers favicon from fromDirectory when enabled", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      const updated = yield* waitForProjectIcon(project.id)

      expect(updated.icon?.url).toStartWith("data:")
      expect(updated.icon?.url).toContain("base64")
    }),
  )

  it.live("should discover favicon.png in root", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      yield* run((svc) => svc.discover(project))

      const updated = Project.get(project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon).toBeDefined()
      expect(updated!.icon?.url).toStartWith("data:")
      expect(updated!.icon?.url).toContain("base64")
      expect(updated!.icon?.color).toBeUndefined()
    }),
  )

  it.live("should not discover non-image files", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.txt"), "not an image"))

      yield* run((svc) => svc.discover(project))

      const updated = Project.get(project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon).toBeUndefined()
    }),
  )

  it.live("should not discover favicon when override is set", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      yield* run((svc) =>
        svc.update({
          projectID: project.id,
          icon: { override: "data:image/png;base64,override" },
        }),
      )

      const updatedProject = yield* run((svc) => svc.get(project.id))
      if (!updatedProject) throw new Error("Project not found")

      const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      yield* Effect.promise(() => Bun.write(path.join(tmp, "favicon.png"), pngData))

      yield* run((svc) => svc.discover(updatedProject))

      const updated = Project.get(project.id)
      expect(updated).toBeDefined()
      expect(updated!.icon?.override).toBe("data:image/png;base64,override")
      expect(updated!.icon?.url).toBeUndefined()
    }),
  )
})

describe("Project.update", () => {
  it.live("should update name", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          name: "New Project Name",
        }),
      )

      expect(updated.name).toBe("New Project Name")

      const fromDb = Project.get(project.id)
      expect(fromDb?.name).toBe("New Project Name")
    }),
  )

  it.live("should update icon url", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          icon: { url: "https://example.com/icon.png" },
        }),
      )

      expect(updated.icon?.url).toBe("https://example.com/icon.png")

      const fromDb = Project.get(project.id)
      expect(fromDb?.icon?.url).toBe("https://example.com/icon.png")
    }),
  )

  it.live("should update icon color", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          icon: { color: "#ff0000" },
        }),
      )

      expect(updated.icon?.color).toBe("#ff0000")

      const fromDb = Project.get(project.id)
      expect(fromDb?.icon?.color).toBe("#ff0000")
    }),
  )

  it.live("should update icon override", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          icon: { override: "data:image/png;base64,abc123" },
        }),
      )

      expect(updated.icon?.override).toBe("data:image/png;base64,abc123")

      const fromDb = Project.get(project.id)
      expect(fromDb?.icon?.override).toBe("data:image/png;base64,abc123")
    }),
  )

  it.live("should update commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          commands: { start: "npm run dev" },
        }),
      )

      expect(updated.commands?.start).toBe("npm run dev")

      const fromDb = Project.get(project.id)
      expect(fromDb?.commands?.start).toBe("npm run dev")
    }),
  )

  it.live("should fail when project not found", () =>
    Effect.gen(function* () {
      const exit = yield* run((svc) =>
        svc.update({
          projectID: ProjectID.make("nonexistent-project-id"),
          name: "Should Fail",
        }),
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toMatchObject({ _tag: "Project.NotFoundError", projectID: "nonexistent-project-id" })
      }
    }),
  )

  it.live("should emit GlobalBus event on update", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      let eventPayload: any = null
      const on = (data: any) => {
        eventPayload = data
      }
      GlobalBus.on("event", on)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

      yield* run((svc) => svc.update({ projectID: project.id, name: "Updated Name" }))

      expect(eventPayload).not.toBeNull()
      expect(eventPayload.payload.type).toBe("project.updated")
      expect(eventPayload.payload.properties.name).toBe("Updated Name")
    }),
  )

  it.live("should update multiple fields at once", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const updated = yield* run((svc) =>
        svc.update({
          projectID: project.id,
          name: "Multi Update",
          icon: { url: "https://example.com/favicon.ico", override: "data:image/png;base64,abc123", color: "#00ff00" },
          commands: { start: "make start" },
        }),
      )

      expect(updated.name).toBe("Multi Update")
      expect(updated.icon?.url).toBe("https://example.com/favicon.ico")
      expect(updated.icon?.override).toBe("data:image/png;base64,abc123")
      expect(updated.icon?.color).toBe("#00ff00")
      expect(updated.commands?.start).toBe("make start")
    }),
  )
})

describe("Project.list and Project.get", () => {
  it.live("list returns all projects", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const all = Project.list()
      expect(all.length).toBeGreaterThan(0)
      expect(all.find((p) => p.id === project.id)).toBeDefined()
    }),
  )

  it.live("get returns project by id", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      const found = Project.get(project.id)
      expect(found).toBeDefined()
      expect(found!.id).toBe(project.id)
    }),
  )

  test("get returns undefined for unknown id", () => {
    const found = Project.get(ProjectID.make("nonexistent"))
    expect(found).toBeUndefined()
  })
})

describe("Project.setInitialized", () => {
  it.live("sets time_initialized on project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))

      expect(project.time.initialized).toBeUndefined()

      Project.setInitialized(project.id)

      const updated = Project.get(project.id)
      expect(updated?.time.initialized).toBeDefined()
    }),
  )
})

describe("Project.addSandbox and Project.removeSandbox", () => {
  it.live("addSandbox adds directory and removeSandbox removes it", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      const sandboxDir = path.join(tmp, "sandbox-test")

      yield* run((svc) => svc.addSandbox(project.id, sandboxDir))

      let found = Project.get(project.id)
      expect(found?.sandboxes).toContain(sandboxDir)

      yield* run((svc) => svc.removeSandbox(project.id, sandboxDir))

      found = Project.get(project.id)
      expect(found?.sandboxes).not.toContain(sandboxDir)
    }),
  )

  it.live("addSandbox emits GlobalBus event", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const { project } = yield* run((svc) => svc.fromDirectory(tmp))
      const sandboxDir = path.join(tmp, "sandbox-event")

      const events: any[] = []
      const on = (evt: any) => events.push(evt)
      GlobalBus.on("event", on)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

      yield* run((svc) => svc.addSandbox(project.id, sandboxDir))

      expect(events.some((e) => e.payload.type === Project.Event.Updated.type)).toBe(true)
    }),
  )
})

describe("Project.fromDirectory with bare repos", () => {
  it.live("worktree from bare repo should cache in bare repo, not parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp)
      const barePath = path.join(parentDir, `bare-${Date.now()}.git`)
      const worktreePath = path.join(parentDir, `worktree-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${barePath} ${worktreePath}`.quiet().nothrow()).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp} ${barePath}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreePath} HEAD`.cwd(barePath).quiet())

      const { project } = yield* run((svc) => svc.fromDirectory(worktreePath))

      expect(project.id).not.toBe(ProjectID.global)
      expect(project.worktree).toBe(barePath)

      const correctCache = path.join(barePath, "opencode")
      const wrongCache = path.join(parentDir, ".git", "opencode")

      expect(yield* Effect.promise(() => Bun.file(correctCache).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(wrongCache).exists())).toBe(false)
    }),
  )

  it.live("different bare repos under same parent should not share project ID", () =>
    Effect.gen(function* () {
      const tmp1 = yield* tmpdirScoped({ git: true })
      const tmp2 = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp1)
      const bareA = path.join(parentDir, `bare-a-${Date.now()}.git`)
      const bareB = path.join(parentDir, `bare-b-${Date.now()}.git`)
      const worktreeA = path.join(parentDir, `wt-a-${Date.now()}`)
      const worktreeB = path.join(parentDir, `wt-b-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${bareA} ${bareB} ${worktreeA} ${worktreeB}`.quiet().nothrow()).pipe(
          Effect.ignore,
        ),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp1} ${bareA}`.quiet())
      yield* Effect.promise(() => $`git clone --bare ${tmp2} ${bareB}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreeA} HEAD`.cwd(bareA).quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreeB} HEAD`.cwd(bareB).quiet())

      const { project: projA } = yield* run((svc) => svc.fromDirectory(worktreeA))
      const { project: projB } = yield* run((svc) => svc.fromDirectory(worktreeB))

      expect(projA.id).not.toBe(projB.id)

      const cacheA = path.join(bareA, "opencode")
      const cacheB = path.join(bareB, "opencode")
      const wrongCache = path.join(parentDir, ".git", "opencode")

      expect(yield* Effect.promise(() => Bun.file(cacheA).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(cacheB).exists())).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(wrongCache).exists())).toBe(false)
    }),
  )

  it.live("bare repo without .git suffix is still detected via core.bare", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })

      const parentDir = path.dirname(tmp)
      const barePath = path.join(parentDir, `bare-no-suffix-${Date.now()}`)
      const worktreePath = path.join(parentDir, `worktree-${Date.now()}`)
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${barePath} ${worktreePath}`.quiet().nothrow()).pipe(Effect.ignore),
      )

      yield* Effect.promise(() => $`git clone --bare ${tmp} ${barePath}`.quiet())
      yield* Effect.promise(() => $`git worktree add ${worktreePath} HEAD`.cwd(barePath).quiet())

      const { project } = yield* run((svc) => svc.fromDirectory(worktreePath))

      expect(project.id).not.toBe(ProjectID.global)
      expect(project.worktree).toBe(barePath)

      const correctCache = path.join(barePath, "opencode")
      expect(yield* Effect.promise(() => Bun.file(correctCache).exists())).toBe(true)
    }),
  )
})
