import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import * as ProjectLocation from "../../src/project/location"
import { LocationLifecycle } from "../../src/project/location-lifecycle"
import type { LocationID } from "../../src/project/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void, unknown> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  Layer.mergeAll(LocationLifecycle.defaultLayer, CrossSpawnSpawner.defaultLayer).pipe(Layer.provide(noopBootstrap)),
)

const setBootstrap = (run: Effect.Effect<void, unknown>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

describe("LocationLifecycle", () => {
  it.live("concurrent admissions share one boot and hold independent leases", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service
      let bootstrapped = 0
      const booted = yield* Deferred.make<void>()
      yield* setBootstrap(
        Effect.gen(function* () {
          bootstrapped++
          yield* Deferred.succeed(booted, undefined)
        }),
      )

      const bothInside = yield* Deferred.make<void>()
      const bothObserved = yield* Deferred.make<void>()
      let inside = 0
      let observed = 0
      const leasesDuring: number[] = []
      const run = lifecycle.provide(
        { directory: dir, purpose: "http-request" },
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (!ctx) return yield* Effect.die(new Error("missing InstanceRef"))
          inside++
          if (inside === 2) yield* Deferred.succeed(bothInside, undefined)
          yield* Deferred.await(bothInside)
          const snap = yield* lifecycle.snapshot(ctx.location.id)
          leasesDuring.push(
            snap.runtime.tag === "stopped" || snap.runtime.tag === "stopping" ? 0 : snap.runtime.leases,
          )
          // Hold the lease until both admissions observed the count, otherwise
          // the first release races the second snapshot.
          observed++
          if (observed === 2) yield* Deferred.succeed(bothObserved, undefined)
          yield* Deferred.await(bothObserved)
        }),
      )

      const a = yield* run.pipe(Effect.forkChild)
      const b = yield* run.pipe(Effect.forkChild)
      yield* Fiber.join(a)
      yield* Fiber.join(b)

      expect(bootstrapped).toBe(1)
      expect(leasesDuring).toEqual([2, 2])
    }),
  )

  it.live("releases the lease on success, typed failure, defect, and interruption", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      const leasesOf = (locationID: LocationID) =>
        lifecycle.snapshot(locationID).pipe(
          Effect.map((snap) =>
            snap.runtime.tag === "stopped" || snap.runtime.tag === "stopping" ? 0 : snap.runtime.leases,
          ),
        )

      // success
      const started = yield* Deferred.make<LocationID>()
      yield* lifecycle.provide(
        { directory: dir, purpose: "http-request" },
        Effect.gen(function* () {
          const ctx = yield* InstanceRef
          if (!ctx) return yield* Effect.die(new Error("missing InstanceRef"))
          yield* Deferred.succeed(started, ctx.location.id)
        }),
      )
      const locationID = yield* Deferred.await(started)
      expect(yield* leasesOf(locationID)).toBe(0)

      // typed failure
      const failed = yield* lifecycle
        .provide({ directory: dir, purpose: "http-request" }, Effect.fail("boom" as const))
        .pipe(Effect.flip)
      expect(failed).toBe("boom")
      expect(yield* leasesOf(locationID)).toBe(0)

      // defect
      const defect = yield* Effect.exit(
        lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.die(new Error("boom"))),
      )
      expect(Exit.isFailure(defect)).toBe(true)
      expect(yield* leasesOf(locationID)).toBe(0)

      // interruption
      const blocked = yield* Deferred.make<void>()
      const fiber = yield* lifecycle
        .provide(
          { directory: dir, purpose: "http-request" },
          Effect.gen(function* () {
            const ctx = yield* InstanceRef
            if (!ctx) return yield* Effect.die(new Error("missing InstanceRef"))
            yield* Deferred.await(blocked)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.succeed(blocked, undefined).pipe(Effect.forkChild)
      yield* Fiber.interrupt(fiber)
      expect(yield* leasesOf(locationID)).toBe(0)
    }),
  )

  it.live("returns to stopped after a failed boot so a retry can start again", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service
      let bootstrapped = 0
      let fail = true
      yield* setBootstrap(
        Effect.suspend(() => {
          bootstrapped++
          return fail ? Effect.fail(new Error("boot failed")) : Effect.void
        }),
      )

      const first = yield* Effect.exit(lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void))
      expect(Exit.isFailure(first)).toBe(true)
      expect(bootstrapped).toBe(1)

      fail = false
      yield* lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void)
      expect(bootstrapped).toBe(2)
    }),
  )

  it.live("rejects a missing directory with LocationUnavailable without bootstrapping", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const missing = `${dir}/missing`
      const lifecycle = yield* LocationLifecycle.Service
      let bootstrapped = 0
      yield* setBootstrap(
        Effect.sync(() => {
          bootstrapped++
        }),
      )

      const error = yield* lifecycle
        .provide({ directory: missing, purpose: "http-request" }, Effect.void)
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(LocationLifecycle.LocationUnavailable)
      expect(bootstrapped).toBe(0)
    }),
  )

  it.live("delete marks location as deleted in DB and blocks further admission", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      // Load the instance to create the location row
      yield* lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void)

      // Delete the location
      const result = yield* lifecycle.delete({ directory: dir })
      expect(result.operationID).toBeTruthy()
      expect(result.generation).toBeGreaterThan(0)

      // Verify DB state is deleted
      const row = yield* Effect.sync(() => ProjectLocation.getByCanonicalDirectory(dir))
      expect(row?.lifecycle.state).toBe("deleted")
      expect(row?.lifecycle.timeDeleted).toBeTruthy()

      // Verify admission is blocked after delete
      const error = yield* lifecycle
        .provide({ directory: dir, purpose: "http-request" }, Effect.void)
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(LocationLifecycle.LocationDeleted)
    }),
  )

  it.live("delete returns LocationBusy when leases are active", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      // Load the instance
      yield* lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void)

      // Hold a lease
      const release = yield* Deferred.make<void>()
      const leaseAcquired = yield* Deferred.make<void>()
      const fiber = yield* lifecycle
        .provide(
          { directory: dir, purpose: "http-request" },
          Effect.gen(function* () {
            yield* Deferred.succeed(leaseAcquired, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(leaseAcquired)

      // Try to delete while lease is held
      const error = yield* lifecycle.delete({ directory: dir }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(LocationLifecycle.LocationBusy)
      expect((error as LocationLifecycle.LocationBusy).leases).toBeGreaterThan(0)

      // Verify DB state is still available (delete was rejected)
      const row = yield* Effect.sync(() => ProjectLocation.getByCanonicalDirectory(dir))
      expect(row?.lifecycle.state).toBe("available")

      // Release the lease
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
    }),
  )

  it.live("delete is idempotent for an already-deleted location", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      yield* lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void)

      const first = yield* lifecycle.delete({ directory: dir, operationID: "op-1" })
      expect(first.operationID).toBe("op-1")

      // Second delete with same operationID should succeed (idempotent)
      const second = yield* lifecycle.delete({ directory: dir, operationID: "op-1" })
      expect(second.operationID).toBe("op-1")
    }),
  )

  it.live("delete calls the filesystem adapter during deletion", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      yield* lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void)

      let adapterCalled = false
      yield* lifecycle.delete({
        directory: dir,
        removeFileSystem: Effect.sync(() => {
          adapterCalled = true
        }),
      })
      expect(adapterCalled).toBe(true)
    }),
  )

  it.live("delete with a different operationID on a deleting location fails", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      yield* lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void)

      // Mark as deleting in DB directly (simulating a crashed delete)
      yield* Effect.sync(() => ProjectLocation.markDeleting({ directory: dir, operationID: "crashed-op" }))

      // Try to delete with a different operation ID
      const error = yield* lifecycle.delete({ directory: dir, operationID: "new-op" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(LocationLifecycle.LocationDeleteFailed)
    }),
  )

  it.live("recoverDeleting finishes tombstone when directory is absent", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      // Load the instance to create the location row
      yield* lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void)

      // Mark as deleting in DB directly (simulating a crashed delete)
      yield* Effect.sync(() => ProjectLocation.markDeleting({ directory: dir, operationID: "crashed-op" }))

      // Remove the directory to simulate the filesystem being gone
      yield* Effect.tryPromise({
        try: () => import("fs/promises").then((fsp) => fsp.rm(dir, { recursive: true, force: true })),
        catch: () => new Error("rm failed"),
      })

      // Run recovery
      yield* lifecycle.recoverDeleting()

      // Verify the location is now deleted
      const row = yield* Effect.sync(() => ProjectLocation.getByCanonicalDirectory(dir))
      expect(row?.lifecycle.state).toBe("deleted")
      expect(row?.lifecycle.timeDeleted).toBeTruthy()
    }),
  )

  it.live("recoverDeleting keeps fence when directory still exists", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      // Load the instance to create the location row
      yield* lifecycle.provide({ directory: dir, purpose: "http-request" }, Effect.void)

      // Mark as deleting in DB directly
      yield* Effect.sync(() => ProjectLocation.markDeleting({ directory: dir, operationID: "ongoing-op" }))

      // Run recovery — directory still exists, so the fence should be kept
      yield* lifecycle.recoverDeleting()

      // Verify the location is still deleting
      const row = yield* Effect.sync(() => ProjectLocation.getByCanonicalDirectory(dir))
      expect(row?.lifecycle.state).toBe("deleting")

      // Admission should be blocked (LocationDeleting)
      const error = yield* lifecycle
        .provide({ directory: dir, purpose: "http-request" }, Effect.void)
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(LocationLifecycle.LocationDeleting)
    }),
  )

  it.live("disposes idle runtime after the idle period", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      // Use a very short idle period for testing
      const original = LocationLifecycle.config.idleDisposalMs
      LocationLifecycle.config.idleDisposalMs = 50

      try {
        const started = yield* Deferred.make<LocationID>()
        yield* lifecycle.provide(
          { directory: dir, purpose: "http-request" },
          Effect.gen(function* () {
            const ctx = yield* InstanceRef
            if (!ctx) return yield* Effect.die(new Error("missing InstanceRef"))
            yield* Deferred.succeed(started, ctx.location.id)
          }),
        )
        const locationID = yield* Deferred.await(started)

        // After provide completes, runtime is running with 0 leases
        let snap = yield* lifecycle.snapshot(locationID)
        expect(snap.runtime.tag).toBe("running")

        // Wait for idle disposal to fire
        yield* pollWithTimeout(
          lifecycle
            .snapshot(locationID)
            .pipe(Effect.map((s) => (s.runtime.tag === "stopped" ? true : undefined))),
          "idle disposal did not complete",
          "3 seconds",
        )

        snap = yield* lifecycle.snapshot(locationID)
        expect(snap.runtime.tag).toBe("stopped")
      } finally {
        LocationLifecycle.config.idleDisposalMs = original
      }
    }),
  )

  it.live("new lease cancels the idle disposal timer", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const lifecycle = yield* LocationLifecycle.Service

      const original = LocationLifecycle.config.idleDisposalMs
      LocationLifecycle.config.idleDisposalMs = 200

      try {
        // First provide — boots runtime, releases lease, schedules idle timer (200ms)
        const started = yield* Deferred.make<LocationID>()
        yield* lifecycle.provide(
          { directory: dir, purpose: "http-request" },
          Effect.gen(function* () {
            const ctx = yield* InstanceRef
            if (!ctx) return yield* Effect.die(new Error("missing InstanceRef"))
            yield* Deferred.succeed(started, ctx.location.id)
          }),
        )
        const locationID = yield* Deferred.await(started)

        // Wait 100ms — idle timer hasn't fired yet (needs 200ms)
        yield* Effect.sleep("100 millis")

        // Fork a provide that holds the lease — this cancels the old timer
        const release = yield* Deferred.make<void>()
        const fiber = yield* lifecycle
          .provide(
            { directory: dir, purpose: "http-request" },
            Effect.gen(function* () {
              yield* Deferred.await(release)
            }),
          )
          .pipe(Effect.forkChild)

        // Wait past the original timer's deadline (300ms total since first
        // timer was scheduled). The old timer was cancelled, and the held
        // lease prevents a new timer from firing.
        yield* Effect.sleep("300 millis")

        const snap = yield* lifecycle.snapshot(locationID)
        expect(snap.runtime.tag).toBe("running")

        // Release the lease — a new idle timer will be scheduled
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(fiber)
      } finally {
        LocationLifecycle.config.idleDisposalMs = original
      }
    }),
  )
})
