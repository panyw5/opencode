import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { Cause, Clock, Context, Deferred, Effect, Fiber, Layer, Scope, SynchronizedRef } from "effect"

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
  fiber?: Fiber.Fiber<void, unknown>
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
      status: Exclude<Status, "running">,
      data?: { output?: string; error?: string },
    ) {
      const completed_at = yield* Clock.currentTimeMillis
      const result = yield* SynchronizedRef.modify(
        (yield* InstanceState.get(state)).jobs,
        (jobs): readonly [FinishResult, Map<string, Active>] => {
          const job = jobs.get(id)
          if (!job) return [{}, jobs]
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
          const s = yield* InstanceState.get(state)
          const id = input.id ?? Identifier.ascending("job")
          const started_at = yield* Clock.currentTimeMillis
          const done = yield* Deferred.make<Info>()
          const promoted = yield* Deferred.make<Info>()

          // Register the job before forking work so list/get/promote see it
          // as soon as run starts (startImmediately can interleave with modify).
          type RegisterResult =
            | { kind: "existing"; info: Info }
            | { kind: "created"; info: Info }
          const registered = yield* SynchronizedRef.modify(s.jobs, (jobs): readonly [RegisterResult, Map<string, Active>] => {
            const existing = jobs.get(id)
            if (existing?.info.status === "running") {
              return [{ kind: "existing", info: snapshot(existing) }, jobs]
            }
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
              promoted,
              onPromote: input.onPromote,
            }
            return [{ kind: "created", info: snapshot(job) }, new Map(jobs).set(id, job)]
          })
          if (registered.kind === "existing") return registered.info

          const fiber = yield* restore(input.run).pipe(
            Effect.matchCauseEffect({
              onSuccess: (output) => finish(id, "completed", { output }),
              onFailure: (cause) =>
                finish(id, Cause.hasInterruptsOnly(cause) ? "cancelled" : "error", {
                  error: errorText(Cause.squash(cause)),
                }),
            }),
            Effect.asVoid,
            Effect.forkIn(s.scope, { startImmediately: true }),
          )
          yield* SynchronizedRef.update(s.jobs, (jobs) => {
            const job = jobs.get(id)
            if (!job || job.info.status !== "running") return jobs
            return new Map(jobs).set(id, { ...job, fiber })
          })
          return registered.info
        }),
      )
    })

    const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
      const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(input.id)
      if (!job) return { timedOut: false }
      if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
      if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
      if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
      const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
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
      const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(id)
      if (!job) return
      if (job.info.status !== "running") return snapshot(job)

      // Mark cancelled before awaiting the fiber. Task runs register
      // `Effect.onInterrupt(() => SessionPrompt.cancel(sessionID))`, and that
      // cancel path re-enters BackgroundJob.cancel for the same id. If we
      // still looked "running" while Fiber.await-ing ourselves, the nested
      // cancel would deadlock and the session runner would never stop.
      const fiber = job.fiber
      const info = yield* finish(id, "cancelled")
      if (fiber) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        yield* Fiber.await(fiber).pipe(Effect.ignore)
      }
      return info
    })

    return Service.of({ list, get, start, wait, waitForPromotion, promote, cancel })
  }),
)

export const defaultLayer = layer

export * as BackgroundJob from "./job"
