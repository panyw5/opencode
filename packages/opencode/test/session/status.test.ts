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
