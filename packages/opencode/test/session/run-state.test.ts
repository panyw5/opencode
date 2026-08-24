import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Ref } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionRunState } from "@/session/run-state"
import * as Session from "@/session/session"
import { testEffect } from "../lib/effect"

const it = testEffect(SessionRunState.defaultLayer)

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
