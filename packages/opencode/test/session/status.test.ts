import { expect } from "bun:test"
import { Context, Effect, Exit, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { Bus } from "@/bus"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { it } from "../lib/effect"

void Log.init({ print: false })

const makeFreshStatus = Effect.gen(function* () {
  const context = yield* Layer.build(Layer.fresh(SessionStatus.defaultLayer))
  return Context.get(context, SessionStatus.Service)
})

const failingBus = Layer.succeed(
  Bus.Service,
  Bus.Service.of({
    publish: () => Effect.die(new Error("bus unavailable")),
    subscribe: () => Effect.die(new Error("unused")),
    subscribeAll: () => Effect.die(new Error("unused")),
    subscribeCallback: () => Effect.die(new Error("unused")),
    subscribeAllCallback: () => Effect.die(new Error("unused")),
  }),
)

const makeStatusWithFailingBus = Effect.gen(function* () {
  const context = yield* Layer.build(Layer.fresh(SessionStatus.layer.pipe(Layer.provide(failingBus))))
  return Context.get(context, SessionStatus.Service)
})

it.instance(
  "shares status across fresh service instances for the same directory",
  Effect.gen(function* () {
    const first = yield* makeFreshStatus
    const second = yield* makeFreshStatus
    const sessionID = SessionID.make("ses_status_shared")

    yield* first.set(sessionID, { type: "busy" })
    expect(yield* second.get(sessionID)).toEqual({ type: "busy" })

    yield* second.set(sessionID, { type: "idle" })
    expect(yield* first.get(sessionID)).toEqual({ type: "idle" })
  }),
)

it.instance(
  "commits idle state before publishing status events",
  Effect.gen(function* () {
    const healthy = yield* makeFreshStatus
    const failing = yield* makeStatusWithFailingBus
    const sessionID = SessionID.make("ses_status_publish_failure")

    yield* healthy.set(sessionID, { type: "busy" })
    const exit = yield* failing.set(sessionID, { type: "idle" }).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* healthy.get(sessionID)).toEqual({ type: "idle" })
  }),
)

const makeFreshStatusWithBus = Effect.gen(function* () {
  // provideMerge keeps Bus.Service in the built context so the subscription
  // observes publishes from the very same Bus instance the service uses.
  const context = yield* Layer.build(Layer.fresh(SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))))
  return {
    status: Context.get(context, SessionStatus.Service),
    bus: Context.get(context, Bus.Service),
  }
})

it.instance(
  "does not publish events for an untracked session going idle",
  Effect.gen(function* () {
    const { status, bus } = yield* makeFreshStatusWithBus
    const events: string[] = []
    yield* bus.subscribeAllCallback((event) => events.push(event.type))
    const sessionID = SessionID.make("ses_status_ghost_idle")

    // The session was never tracked (never busy): publishing would emit a
    // ghost `session.idle`, e.g. runner cleanup during idle disposal.
    yield* status.set(sessionID, { type: "idle" })
    // Subscriptions deliver on a forked fiber — let it drain.
    yield* Effect.sleep("20 millis")

    expect(events).toEqual([])
  }),
)

it.instance(
  "publishes idle exactly once across redundant idle transitions",
  Effect.gen(function* () {
    const { status, bus } = yield* makeFreshStatusWithBus
    const events: string[] = []
    yield* bus.subscribeAllCallback((event) => events.push(event.type))
    const sessionID = SessionID.make("ses_status_redundant_idle")

    yield* status.set(sessionID, { type: "busy" })
    yield* status.set(sessionID, { type: "idle" })
    yield* status.set(sessionID, { type: "idle" })
    yield* status.set(sessionID, { type: "idle" })
    // Subscriptions deliver on a forked fiber — let it drain.
    yield* Effect.sleep("20 millis")

    expect(events.filter((type) => type === "session.idle")).toHaveLength(1)
    // One status event for busy, one for the first (real) idle transition.
    expect(events.filter((type) => type === "session.status")).toHaveLength(2)
  }),
)
