import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Path } from "@opencode-ai/core/util/path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { localPathContext } from "../../src/project/instance-context"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
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

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(disposer)),
    (off) => Effect.sync(off),
  )

describe("InstanceStore", () => {
  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(Path.logical(dir, localPathContext))
      expect(ctx.worktree).toBe(Path.logical(dir, localPathContext))
      expect(String(ctx.directoryKey)).toBe(String(Path.identity(dir, localPathContext)))
      expect(String(ctx.nativeDirectory)).toBe(String(Path.native(dir, localPathContext)))
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(Path.logical(dir, localPathContext))
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("promotes a cached internal instance when the user explicitly opens it", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const internal = yield* store.load({
        directory: dir,
        registration: { visibility: "internal", kind: "math" },
      })
      const visible = yield* store.load({ directory: dir })
      const visibleAgain = yield* store.load({ directory: dir })
      const internalAgain = yield* store.load({
        directory: dir,
        registration: { visibility: "internal", kind: "math" },
      })

      expect(internal.project.visibility).toBe("internal")
      expect(visible.project.visibility).toBe("user")
      expect(visibleAgain.project.visibility).toBe("user")
      expect(internalAgain.project.visibility).toBe("user")
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes Windows slash, drive-case, and trailing-slash aliases", () =>
    Effect.gen(function* () {
      if (localPathContext.platform !== "win32") return
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )

      const forward = dir.replace(/\\/g, "/")
      const alias = `${forward[0]!.toLowerCase()}${forward.slice(1)}/`
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: alias })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
      expect(String(first.directoryKey)).toBe(String(Path.identity(alias, localPathContext)))
    }),
  )

  it.live("keeps POSIX case variants in separate instance identities", () =>
    Effect.gen(function* () {
      if (localPathContext.platform === "win32") return
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const base = yield* store.load({ directory: dir })
      const lower = `${dir}-case`
      const upper = `${dir}-CASE`

      const first = yield* store.load({
        directory: lower,
        worktree: lower,
        project: base.project,
        location: base.location,
      })
      const second = yield* store.load({
        directory: upper,
        worktree: upper,
        project: base.project,
        location: base.location,
      })

      expect(first).not.toBe(second)
      expect(String(first.directoryKey)).not.toBe(String(second.directoryKey))
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(Path.logical(dir, localPathContext))
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([String(Path.identity(dir, localPathContext))])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([String(Path.identity(dir, localPathContext))])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([String(Path.identity(dir, localPathContext))])
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([String(Path.identity(dir1, localPathContext))])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([
        String(Path.identity(dir1, localPathContext)),
        String(Path.identity(dir2, localPathContext)),
      ])
    }),
  )
})
