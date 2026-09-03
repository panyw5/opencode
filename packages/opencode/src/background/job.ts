import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Cause, Clock, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, SynchronizedRef } from "effect"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  cleanup: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<void, unknown>
  token: object
  promoted: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
}

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  /** Runs once when a foreground job is promoted to background (does not interrupt run). */
  onPromote?: Effect.Effect<void>
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("BackgroundJob.state")(function* () {
        return {
          jobs: yield* SynchronizedRef.make(new Map()),
          scope: yield* Scope.Scope,
        }
      }),
    )

    const finish = Effect.fn("BackgroundJob.finish")(function* (
      id: string,
      token: object,
      status: Exclude<Status, "running">,
      data?: { output?: string; error?: string },
    ) {
      const completed_at = yield* Clock.currentTimeMillis
      const result = yield* SynchronizedRef.modify(
        (yield* InstanceState.get(state)).jobs,
        (jobs): readonly [FinishResult, Map<string, Active>] => {
          const job = jobs.get(id)
          if (!job) return [{}, jobs]
          if (job.token !== token) return [{}, jobs]
          if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
          const next = {
            ...job,
            fiber: undefined,
            onPromote: undefined,
            info: {
              ...job.info,
              status,
              completed_at,
              ...(data?.output !== undefined ? { output: data.output } : {}),
              ...(data?.error !== undefined ? { error: data.error } : {}),
            },
          }
          return [{ info: snapshot(next), done: job.done }, new Map(jobs).set(id, next)]
        },
      )
      if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
      return result.info
    })

    const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
      return Array.from((yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).values())
        .map(snapshot)
        .toSorted((a, b) => a.started_at - b.started_at)
    })

    const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
      const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(id)
      if (!job) return
      return snapshot(job)
    })

    const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const directory = (yield* InstanceState.context).directory
          const id = input.id ?? Identifier.ascending("job")
          while (true) {
            const s = yield* InstanceState.get(state)
            const started_at = yield* Clock.currentTimeMillis
            const done = yield* Deferred.make<Info>()
            const cleanup = yield* Deferred.make<void>()
            const promoted = yield* Deferred.make<Info>()
            const scope = yield* Scope.make()
            const token = {}

            // Register the job before forking work so list/get/promote see it
            // as soon as run starts (startImmediately can interleave with modify).
            type RegisterResult =
              | { kind: "existing"; info: Info }
              | { kind: "wait"; cleanup: Deferred.Deferred<void>; token: object }
              | { kind: "created"; info: Info }
            const registered = yield* SynchronizedRef.modify(
              s.jobs,
              (jobs): readonly [RegisterResult, Map<string, Active>] => {
                const existing = jobs.get(id)
                if (existing?.info.status === "running") {
                  return [{ kind: "existing", info: snapshot(existing) }, jobs]
                }
                if (existing) return [{ kind: "wait", cleanup: existing.cleanup, token: existing.token }, jobs]
                const job: Active = {
                  info: {
                    id,
                    type: input.type,
                    title: input.title,
                    status: "running",
                    started_at,
                    metadata: input.metadata,
                  },
                  done,
                  cleanup,
                  token,
                  promoted,
                  onPromote: input.onPromote,
                }
                return [{ kind: "created", info: snapshot(job) }, new Map(jobs).set(id, job)]
              },
            )
            if (registered.kind === "existing") {
              yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
              return registered.info
            }
            if (registered.kind === "wait") {
              yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
              yield* restore(Deferred.await(registered.cleanup))
              yield* SynchronizedRef.update(s.jobs, (jobs) => {
                const existing = jobs.get(id)
                if (!existing || existing.token !== registered.token || existing.info.status === "running") return jobs
                const next = new Map(jobs)
                next.delete(id)
                return next
              })
              continue
            }

            const ready = yield* Deferred.make<void>()
            const close = (exit: Exit.Exit<unknown, unknown>) =>
              Scope.close(scope, exit).pipe(Effect.exit, Effect.asVoid)
            // Hold a location lease for the job's full run: from after the
            // ready gate until terminal settlement (completion, failure, or
            // cancellation). Scope close and finish bookkeeping stay outside
            // the lease so they keep running uninterruptibly.
            const fiber = yield* restore(
              LocationLifecycle.lease(
                { directory, purpose: "background-job" },
                Deferred.await(ready).pipe(Effect.andThen(input.run.pipe(Scope.provide(scope)))),
              ),
            ).pipe(
              Effect.matchCauseEffect({
                onSuccess: (output) =>
                  finish(id, token, "completed", { output }).pipe(Effect.andThen(close(Exit.void))),
                onFailure: (cause) =>
                  finish(id, token, Cause.hasInterruptsOnly(cause) ? "cancelled" : "error", {
                    error: errorText(Cause.squash(cause)),
                  }).pipe(
                    Effect.andThen(
                      close(Exit.failCause(cause)),
                    ),
                  ),
              }),
              Effect.ensuring(
                close(Exit.void).pipe(Effect.andThen(Deferred.succeed(cleanup, undefined)), Effect.asVoid),
              ),
              Effect.asVoid,
              Effect.forkIn(s.scope, { startImmediately: true }),
            )
            const installed = yield* SynchronizedRef.modify(s.jobs, (jobs): readonly [boolean, Map<string, Active>] => {
              const job = jobs.get(id)
              if (!job || job.token !== token || job.info.status !== "running") return [false, jobs]
              return [true, new Map(jobs).set(id, { ...job, fiber })]
            })
            if (installed) {
              yield* Deferred.succeed(ready, undefined)
            } else {
              yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
              yield* Fiber.await(fiber).pipe(Effect.ignore)
            }
            return registered.info
          }
        }),
      )
    })

    const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
      const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(input.id)
      if (!job) return { timedOut: false }
      const result = Deferred.await(job.done).pipe(
        Effect.andThen((info) => Deferred.await(job.cleanup).pipe(Effect.as(info))),
      )
      if (job.info.status !== "running" && input.timeout === undefined) return { info: yield* result, timedOut: false }
      if (input.timeout === undefined) return { info: yield* result, timedOut: false }
      const info = yield* result.pipe(Effect.timeoutOption(Math.max(0, input.timeout)))
      if (info._tag === "Some") return { info: info.value, timedOut: false }
      return { info: snapshot(job), timedOut: true }
    })

    const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
      const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(id)
      if (!job || job.info.status !== "running") return yield* Effect.never
      if (job.info.metadata?.background === true) return snapshot(job)
      return yield* Deferred.await(job.promoted)
    })

    const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
      const result = yield* SynchronizedRef.modify(
        (yield* InstanceState.get(state)).jobs,
        (jobs): readonly [PromoteResult, Map<string, Active>] => {
          const job = jobs.get(id)
          if (!job || job.info.status !== "running") return [{}, jobs]
          if (job.info.metadata?.background === true) return [{ info: snapshot(job) }, jobs]
          const next: Active = {
            ...job,
            onPromote: undefined,
            info: {
              ...job.info,
              metadata: { ...job.info.metadata, background: true },
            },
          }
          return [{ info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted }, new Map(jobs).set(id, next)]
        },
      )
      if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
      if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
      return result.info
    })

    const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(id)
          if (!job) return
          if (job.info.status !== "running") return snapshot(job)

          // Mark cancelled before awaiting the fiber. Task runs register
          // `Effect.onInterrupt(() => SessionPrompt.cancel(sessionID))`, and that
          // cancel path re-enters BackgroundJob.cancel for the same id. If we
          // still looked "running" while Fiber.await-ing ourselves, the nested
          // cancel would deadlock and the session runner would never stop.
          const fiber = job.fiber
          const info = yield* finish(id, job.token, "cancelled")
          if (fiber) {
            yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
            yield* Fiber.await(fiber).pipe(Effect.ignore)
          } else {
            yield* Deferred.await(job.cleanup)
          }
          return info
        }),
      )
    })

    return Service.of({ list, get, start, wait, waitForPromotion, promote, cancel })
  }),
)

export const defaultLayer = layer

export * as BackgroundJob from "./job"
