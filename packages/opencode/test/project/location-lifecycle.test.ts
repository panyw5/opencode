import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { LocationLifecycle } from "../../src/project/location-lifecycle"
import type { LocationID } from "../../src/project/schema"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
})
