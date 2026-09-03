import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Pty } from "../../src/pty"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { LocationLifecycle } from "../../src/project/location-lifecycle"
import { Shell } from "../../src/shell/shell"
import { requireInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

Shell.preferred.reset()

const it = testEffect(
  Layer.mergeAll(Pty.defaultLayer, LocationLifecycle.defaultLayer).pipe(
    Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
  ),
)

const leaseCount = (lifecycle: LocationLifecycle.Interface, locationID: Parameters<typeof lifecycle.snapshot>[0]) =>
  lifecycle.snapshot(locationID).pipe(
    Effect.map((snap) => (snap.runtime.tag === "stopped" || snap.runtime.tag === "stopping" ? 0 : snap.runtime.leases)),
    // No entry exists before the first admission reaches the gate.
    Effect.catch(() => Effect.succeed(0)),
  )

const expectLeases = (
  lifecycle: LocationLifecycle.Interface,
  locationID: Parameters<typeof lifecycle.snapshot>[0],
  expected: number,
) =>
  pollWithTimeout(
    leaseCount(lifecycle, locationID).pipe(Effect.map((leases) => (leases === expected ? true : undefined))),
    `lease count did not become ${expected}`,
  )

describe("pty location lease", () => {
  it.instance(
    "holds one lease from creation until removal",
    () =>
      Effect.gen(function* () {
        const ctx = yield* requireInstance
        const lifecycle = yield* LocationLifecycle.Service
        const pty = yield* Pty.Service

        const info = yield* pty.create({ title: "lease" })
        yield* expectLeases(lifecycle, ctx.location.id, 1)

        yield* pty.remove(info.id)
        yield* expectLeases(lifecycle, ctx.location.id, 0)
      }),
    { git: true },
    { timeout: 30000 },
  )

  it.instance(
    "releases the lease when the process exits on its own",
    () =>
      Effect.gen(function* () {
        const ctx = yield* requireInstance
        const lifecycle = yield* LocationLifecycle.Service
        const pty = yield* Pty.Service

        // A command that terminates immediately: onExit routes through
        // remove(), which must release the lease exactly once. The lease
        // count of 1 can be too transient to observe here; acquisition is
        // covered by the removal test above.
        const exit =
          process.platform === "win32"
            ? { command: "cmd.exe", args: ["/c", "exit", "0"] }
            : { command: "sh", args: ["-c", "exit 0"] }
        const info = yield* pty.create({ ...exit, title: "lease-exit" })

        yield* pollWithTimeout(
          pty.list().pipe(Effect.map((items) => (items.some((item) => item.id === info.id) ? undefined : true))),
          "pty was not removed after exit",
        )
        yield* expectLeases(lifecycle, ctx.location.id, 0)

        // remove() after a natural exit must not double-release.
        yield* pty.remove(info.id).pipe(Effect.ignore)
        expect(yield* leaseCount(lifecycle, ctx.location.id)).toBe(0)
      }),
    { git: true },
    { timeout: 30000 },
  )
})
