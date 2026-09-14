import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import * as EffectLogger from "@opencode-ai/core/effect/logger"

const elog = EffectLogger.create({ service: "session.run-state" })

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID, cleanup?: Effect.Effect<void>) => Effect.Effect<void>
  readonly revision: (sessionID: SessionID, onInterrupt: Effect.Effect<MessageV2.WithParts>) => Effect.Effect<number>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    revision?: number,
  ) => Effect.Effect<MessageV2.WithParts>
  /**
   * Interrupt the in-flight run and start replacement work while keeping
   * callers coalesced on the interrupted run attached to the replacement —
   * they receive its final result instead of unwinding with a cancellation.
   */
  readonly gracefulRestart: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        const interruptHandlers = new Map<SessionID, Effect.Effect<MessageV2.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            interruptHandlers.clear()
          }),
        )
        return { runners, interruptHandlers, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt?: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      if (onInterrupt) data.interruptHandlers.set(sessionID, onInterrupt)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          yield* status.set(sessionID, { type: "idle" }).pipe(
            Effect.catchCause((cause) =>
              elog.error("runner idle status update failed", {
                sessionID,
                source: "runner",
                reason: cause,
              }),
            ),
          )
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt: Effect.suspend(() => data.interruptHandlers.get(sessionID) ?? Effect.interrupt),
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (
      sessionID: SessionID,
      cleanup: Effect.Effect<void> = Effect.void,
    ) {
      // Stop the session runner first so the agent loop cannot keep producing
      // turns while background-job teardown (or a re-entrant cancel) is in flight.
      const existing = yield* runner(sessionID)
      yield* existing.cancelWith(
        Effect.gen(function* () {
          yield* elog.info("cancel stopping background jobs", { sessionID })
          yield* cancelBackgroundJobs(background, sessionID)
          yield* elog.info("cancel finalizing messages", { sessionID })
          yield* cleanup
        }),
      )
    })

    // Hold a location lease for the complete run, not only admission: the
    // runner fiber outlives the HTTP request that started it, and a renderer
    // disconnect must not release backend work. The lease is released exactly
    // once by the gate's finalizer on success, failure, interruption, or
    // instance teardown. Resolution is soft so bare unit-test layers without
    // the lifecycle service keep running unleased.
    const leased = (work: Effect.Effect<MessageV2.WithParts>) =>
      InstanceState.context.pipe(
        Effect.flatMap((ctx) => LocationLifecycle.lease({ directory: ctx.directory, purpose: "session-run" }, work)),
      )

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      revision?: number,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(leased(work), revision)
    })

    const gracefulRestart = Effect.fn("SessionRunState.gracefulRestart")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).gracefulRestart(leased(work))
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(leased(work), ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    const revision = Effect.fn("SessionRunState.revision")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      return (yield* runner(sessionID, onInterrupt)).revision
    })
    return Service.of({ assertNotBusy, cancel, revision, ensureRunning, gracefulRestart, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
