import { $ } from "bun"
import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Worktree } from "../../src/worktree"
import { provideTmpdirInstance, tmpdirScoped, withTestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  Layer.mergeAll(InstanceStore.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(Layer.provide(noopBootstrap)),
)

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const exists = (dir: string) =>
  Effect.promise(() =>
    fs
      .stat(dir)
      .then(() => true)
      .catch(() => false),
  )

// Characterization tests for the directory lifecycle gaps described in
// specs/v2/location-lifecycle.md. Each test documents behavior that the
// lifecycle admission gate (LocationLifecycle) will change; update them when
// the corresponding PR lands.
describe("instance directory lifecycle gaps", () => {
  it.live("loads an instance for a directory that does not exist", () =>
    // Gap: internal callers bypass the HTTP existsSafe guard, so any path
    // string mints a live instance. No git init here so fs.up cannot find a
    // parent .git and the directory itself never touches the filesystem.
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const missing = path.join(dir, "missing")
      const store = yield* InstanceStore.Service
      let bootstrapped = 0

      yield* setBootstrap(
        Effect.sync(() => {
          bootstrapped++
        }),
      )
      const ctx = yield* store.load({ directory: missing })

      expect(yield* exists(missing)).toBe(false)
      expect(bootstrapped).toBe(1)
      expect(ctx.directory).toBe(missing)

      yield* store.dispose(ctx)
    }),
  )

  it.live("revives a disposed instance on the next load without any fence", () =>
    // Gap: nothing prevents an instance from coming back right after dispose,
    // so a stale caller can resurrect a directory that was meant to be gone.
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let bootstrapped = 0

      yield* setBootstrap(
        Effect.sync(() => {
          bootstrapped++
        }),
      )
      const first = yield* store.load({ directory: dir })
      yield* store.dispose(first)
      const second = yield* store.load({ directory: dir })

      expect(bootstrapped).toBe(2)
      expect(second).not.toBe(first)

      yield* store.dispose(second)
    }),
  )

  const worktreeIt = testEffect(Layer.mergeAll(Worktree.defaultLayer, CrossSpawnSpawner.defaultLayer))

  worktreeIt.live("removes a worktree directory while its instance stays cached", () =>
    // Gap: Worktree.remove deletes the directory without disposing the
    // instance first, so the cached instance keeps serving a deleted path.
    provideTmpdirInstance(
      (root) =>
        Effect.gen(function* () {
          const svc = yield* Worktree.Service
          const name = `lifecycle-gap-${Date.now().toString(36)}`
          const branch = `opencode/${name}`
          const dir = path.join(root, "..", name)

          yield* Effect.promise(() => $`git worktree add --no-checkout -b ${branch} ${dir}`.cwd(root).quiet())
          yield* Effect.promise(() => $`git reset --hard`.cwd(dir).quiet())

          const before = yield* Effect.promise(() => withTestInstance({ directory: dir, fn: (ctx) => ctx }))
          const ok = yield* svc.remove({ directory: dir })

          expect(ok).toBe(true)
          expect(yield* exists(dir)).toBe(false)

          const after = yield* Effect.promise(() => withTestInstance({ directory: dir, fn: (ctx) => ctx }))
          expect(after).toBe(before)

          yield* Effect.promise(() =>
            $`git worktree list --porcelain`.cwd(root).quiet().text(),
          ).pipe(
            Effect.tap((list) =>
              Effect.sync(() => {
                expect(list).not.toContain(`worktree ${dir}`)
              }),
            ),
          )
        }),
      { git: true },
    ),
  )
})
