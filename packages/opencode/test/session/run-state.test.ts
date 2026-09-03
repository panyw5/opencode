import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Ref } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionRunState } from "@/session/run-state"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { LocationLifecycle } from "@/project/location-lifecycle"
import * as Session from "@/session/session"
import { requireInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(SessionRunState.defaultLayer)

const lifecycleIt = testEffect(
  Layer.mergeAll(SessionRunState.defaultLayer, LocationLifecycle.defaultLayer).pipe(
    Layer.provide(Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))),
  ),
)

function reply(sessionID: SessionID, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test-provider"),
      mode: "general",
      agent: "general",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text }],
  }
}

describe("SessionRunState", () => {
  it.instance("shares one runner owner across concurrent callers", () =>
    Effect.gen(function* () {
      const service = yield* SessionRunState.Service
      const sessionID = SessionID.descending()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const calls = yield* Ref.make<string[]>([])
      const interrupted = reply(sessionID, "interrupted")

      const first = yield* service
        .ensureRunning(
          sessionID,
          Effect.succeed(interrupted),
          Effect.gen(function* () {
            yield* Ref.update(calls, (items) => [...items, "first"])
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return reply(sessionID, "first")
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const second = yield* service
        .ensureRunning(
          sessionID,
          Effect.succeed(interrupted),
          Ref.update(calls, (items) => [...items, "second"]).pipe(Effect.as(reply(sessionID, "second"))),
        )
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)

      const [a, b] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(a.parts[0]?.type === "text" ? a.parts[0].text : undefined).toBe("first")
      expect(b.parts[0]?.type === "text" ? b.parts[0].text : undefined).toBe("first")
      expect(yield* Ref.get(calls)).toEqual(["first"])
    }),
  )

  it.instance("translates a second shell owner into BusyError", () =>
    Effect.gen(function* () {
      const service = yield* SessionRunState.Service
      const sessionID = SessionID.descending()
      const started = yield* Deferred.make<void>()
      const fallback = reply(sessionID, "interrupted")
      const shell = yield* service
        .startShell(
          sessionID,
          Effect.succeed(fallback),
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.as(fallback)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      const exit = yield* service
        .startShell(sessionID, Effect.succeed(fallback), Effect.succeed(reply(sessionID, "second")))
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)

      yield* service.cancel(sessionID)
      expect(yield* Fiber.join(shell)).toEqual(fallback)
    }),
  )

  it.instance("runs the interrupt fallback and allows a later owner", () =>
    Effect.gen(function* () {
      const service = yield* SessionRunState.Service
      const sessionID = SessionID.descending()
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const fallback = reply(sessionID, "interrupted")
      const active = yield* service
        .ensureRunning(
          sessionID,
          Effect.succeed(fallback),
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
            Effect.as(reply(sessionID, "never")),
          ),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      yield* service.cancel(sessionID)
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      expect(yield* Fiber.join(active)).toEqual(fallback)

      const next = yield* service.ensureRunning(
        sessionID,
        Effect.succeed(fallback),
        Effect.succeed(reply(sessionID, "next")),
      )
      expect(next.parts[0]?.type === "text" ? next.parts[0].text : undefined).toBe("next")
    }),
  )
})

describe("SessionRunState location lease", () => {
  const leaseCount = (lifecycle: LocationLifecycle.Interface, locationID: Parameters<typeof lifecycle.snapshot>[0]) =>
    lifecycle.snapshot(locationID).pipe(
      Effect.map((snap) =>
        snap.runtime.tag === "stopped" || snap.runtime.tag === "stopping" ? 0 : snap.runtime.leases,
      ),
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

  lifecycleIt.instance(
    "holds one lease for the complete run and releases it on success",
    () =>
      Effect.gen(function* () {
        const ctx = yield* requireInstance
        const service = yield* SessionRunState.Service
        const lifecycle = yield* LocationLifecycle.Service
        const sessionID = SessionID.descending()
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()

        const done = yield* service
          .ensureRunning(
            sessionID,
            Effect.succeed(reply(sessionID, "interrupted")),
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              return reply(sessionID, "ran")
            }),
          )
          .pipe(Effect.forkChild)

        // `started` fires inside the leased work, so the lease is already held.
        yield* Deferred.await(started)
        expect(yield* leaseCount(lifecycle, ctx.location.id)).toBe(1)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(done)
        yield* expectLeases(lifecycle, ctx.location.id, 0)
      }),
    { git: true },
  )

  lifecycleIt.instance(
    "releases the lease when the run is cancelled",
    () =>
      Effect.gen(function* () {
        const ctx = yield* requireInstance
        const service = yield* SessionRunState.Service
        const lifecycle = yield* LocationLifecycle.Service
        const sessionID = SessionID.descending()
        const started = yield* Deferred.make<void>()

        const active = yield* service
          .ensureRunning(
            sessionID,
            Effect.succeed(reply(sessionID, "interrupted")),
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.as(reply(sessionID, "never")),
            ),
          )
          .pipe(Effect.forkChild)

        yield* Deferred.await(started)
        expect(yield* leaseCount(lifecycle, ctx.location.id)).toBe(1)

        yield* service.cancel(sessionID)
        yield* Fiber.join(active)
        yield* expectLeases(lifecycle, ctx.location.id, 0)
      }),
    { git: true },
  )
})
