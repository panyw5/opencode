import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Ref } from "effect"
import { BackgroundJob } from "@/background/job"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { withTmpdirInstance } from "../fixture/fixture"

const it = testEffect(BackgroundJob.defaultLayer)

describe("background.job", () => {
  it.instance("tracks started jobs through completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        title: "test job",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      expect(job.id.startsWith("job_")).toBe(true)
      expect(job.status).toBe("running")
      expect(job.title).toBe("test job")

      yield* Deferred.succeed(latch, undefined)
      const done = yield* jobs.wait({ id: job.id })

      expect(done.timedOut).toBe(false)
      expect(done.info?.status).toBe("completed")
      expect(done.info?.output).toBe("done")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([job.id])
    }),
  )

  it.instance("closes each job scope exactly once on completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const finalized = yield* Ref.make(0)
      const job = yield* jobs.start({
        type: "test",
        run: Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Ref.update(finalized, (count) => count + 1))
          return "done"
        }),
      })

      const result = yield* jobs.wait({ id: job.id })

      expect(result.info?.status).toBe("completed")
      expect(result.info?.output).toBe("done")
      expect(yield* Ref.get(finalized)).toBe(1)
      expect((yield* jobs.wait({ id: job.id, timeout: 0 })).timedOut).toBe(false)
      expect((yield* jobs.cancel(job.id))?.status).toBe("completed")
      expect(yield* Ref.get(finalized)).toBe(1)
    }),
  )

  it.instance("publishes one terminal result to concurrent waiters", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })
      const waiters = yield* Effect.all(
        Array.from({ length: 8 }, () => jobs.wait({ id: job.id }).pipe(Effect.forkChild)),
      )

      yield* Deferred.succeed(latch, undefined)
      const results = yield* Effect.all(waiters.map(Fiber.join), { concurrency: "unbounded" })

      expect(results.every((result) => result.info?.status === "completed")).toBe(true)
      expect(results.every((result) => result.info?.output === "done")).toBe(true)
      expect((yield* jobs.cancel(job.id))?.status).toBe("completed")
    }),
  )

  it.instance("returns a running snapshot when wait times out", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never,
      })

      const result = yield* jobs.wait({ id: job.id, timeout: 1 })

      expect(result.timedOut).toBe(true)
      expect(result.info?.status).toBe("running")
    }),
  )

  it.instance("deduplicates concurrent starts for a running id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const id = "job_test"
      const [first, second] = yield* Effect.all(
        [
          jobs.start({
            id,
            type: "test",
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          jobs.start({
            id,
            type: "test",
            run: Effect.fail(new Error("duplicate started")),
          }),
        ],
        { concurrency: "unbounded" },
      )

      yield* Deferred.await(started)

      expect(first.id).toBe(id)
      expect(second.id).toBe(id)
      expect(first.status).toBe("running")
      expect(second.status).toBe("running")
      expect((yield* jobs.list()).map((item) => item.id)).toEqual([id])

      yield* jobs.cancel(id)
    }),
  )

  it.instance("records failed jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.fail(new Error("boom")),
      })

      const result = yield* jobs.wait({ id: job.id })

      expect(result.info?.status).toBe("error")
      expect(result.info?.error).toBe("boom")
    }),
  )

  it.instance("publishes completion even when a scope finalizer defects", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        run: Effect.addFinalizer(() => Effect.die(new Error("cleanup defect"))).pipe(Effect.as("done")),
      })

      const result = yield* jobs.wait({ id: job.id }).pipe(Effect.timeout("1 second"))

      expect(result.info?.status).toBe("completed")
      expect(result.info?.output).toBe("done")
    }),
  )

  it.instance("allows a completion finalizer to re-enter cancel without self-deadlock", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const id = "job_completion_reentrant"
      const finalizerFinished = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        id,
        type: "test",
        run: Effect.addFinalizer(() =>
          jobs.cancel(id).pipe(Effect.andThen(Deferred.succeed(finalizerFinished, undefined))),
        ).pipe(Effect.as("done")),
      })

      const result = yield* jobs.wait({ id: job.id }).pipe(Effect.timeout("1 second"))

      expect(result.info?.status).toBe("completed")
      yield* Deferred.await(finalizerFinished).pipe(Effect.timeout("1 second"))
    }),
  )

  it.instance("can cancel running jobs", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const interrupted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })

      const cancelled = yield* jobs.cancel(job.id)

      expect(cancelled?.status).toBe("cancelled")
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("closes each job scope exactly once under concurrent cancellation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const finalized = yield* Ref.make(0)
      const job = yield* jobs.start({
        type: "test",
        run: Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Ref.update(finalized, (count) => count + 1))
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      })
      yield* Deferred.await(started)

      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => jobs.cancel(job.id)),
        {
          concurrency: "unbounded",
        },
      )

      expect(results.every((result) => result?.status === "cancelled")).toBe(true)
      expect(yield* Ref.get(finalized)).toBe(1)
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancel survives re-entrant cancel from onInterrupt (no self-deadlock)", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      const nestedCancelEntered = yield* Deferred.make<void>()
      const nestedCancelFinished = yield* Deferred.make<void>()

      const job = yield* jobs.start({
        id: "job_reentrant_cancel",
        type: "test",
        run: Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Effect.never
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(nestedCancelEntered, undefined)
              // Mirrors TaskTool: onInterrupt → SessionPrompt.cancel → BackgroundJob.cancel(same id)
              yield* jobs.cancel("job_reentrant_cancel")
              yield* Deferred.succeed(nestedCancelFinished, undefined)
            }),
          ),
        ),
      })

      yield* Deferred.await(started)

      const cancelled = yield* jobs.cancel(job.id).pipe(Effect.timeout("2 seconds"))
      expect(cancelled?.status).toBe("cancelled")
      yield* Deferred.await(nestedCancelEntered).pipe(Effect.timeout("1 second"))
      yield* Deferred.await(nestedCancelFinished).pipe(Effect.timeout("1 second"))
      expect((yield* jobs.get(job.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("does not let an old generation finish a restarted job with the same id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const id = "job_restart"
      const oldStarted = yield* Deferred.make<void>()
      const reentrantCancelFinished = yield* Deferred.make<void>()
      const releaseOldCleanup = yield* Deferred.make<void>()
      yield* jobs.start({
        id,
        type: "old",
        run: Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.await(releaseOldCleanup))
          yield* Deferred.succeed(oldStarted, undefined)
          return yield* Effect.never
        }).pipe(
          Effect.onInterrupt(() =>
            jobs.cancel(id).pipe(Effect.andThen(Deferred.succeed(reentrantCancelFinished, undefined))),
          ),
        ),
      })
      yield* Deferred.await(oldStarted)

      const cancelling = yield* jobs.cancel(id).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        jobs.get(id).pipe(Effect.map((info) => (info?.status === "cancelled" ? true : undefined))),
        "old job never entered cancelled state",
      )

      const replacementStarted = yield* Deferred.make<void>()
      const replacement = yield* jobs
        .start({
          id,
          type: "replacement",
          run: Deferred.succeed(replacementStarted, undefined).pipe(Effect.andThen(Effect.never)),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(reentrantCancelFinished).pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(releaseOldCleanup, undefined)
      yield* Fiber.join(cancelling)
      yield* Fiber.join(replacement)
      yield* Deferred.await(replacementStarted)

      expect((yield* jobs.get(id))?.status).toBe("running")
      expect((yield* jobs.get(id))?.type).toBe("replacement")
      yield* jobs.cancel(id)
    }),
  )

  it.instance("finishes cancellation cleanup when the cancel caller is interrupted", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const id = "job_interrupted_cancel"
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      yield* jobs.start({
        id,
        type: "old",
        run: Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.await(releaseCleanup))
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      })
      yield* Deferred.await(started)

      const cancelling = yield* jobs.cancel(id).pipe(Effect.forkChild)
      yield* pollWithTimeout(
        jobs.get(id).pipe(Effect.map((info) => (info?.status === "cancelled" ? true : undefined))),
        "job never entered cancelled state",
      )
      const interruptCaller = yield* Fiber.interrupt(cancelling).pipe(Effect.forkChild)
      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
      yield* Deferred.succeed(releaseCleanup, undefined)
      yield* Fiber.join(interruptCaller)

      const replacement = yield* jobs.start({ id, type: "replacement", run: Effect.succeed("done") })
      expect((yield* jobs.wait({ id: replacement.id })).info?.status).toBe("completed")
    }),
  )

  it.instance("returns immutable snapshots", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const job = yield* jobs.start({
        type: "test",
        metadata: { value: "initial" },
        run: Effect.succeed("done"),
      })

      if (job.metadata) job.metadata.value = "changed"

      expect((yield* jobs.get(job.id))?.metadata?.value).toBe("initial")
    }),
  )

  it.instance("promotes running jobs without interrupting them", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const promoted = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        metadata: { parentSessionId: "parent" },
        onPromote: Deferred.succeed(promoted, undefined).pipe(Effect.asVoid),
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      const info = yield* jobs.promote(job.id)

      expect(info?.status).toBe("running")
      expect(info?.metadata?.background).toBe(true)
      yield* Deferred.await(promoted)
      expect((yield* jobs.get(job.id))?.status).toBe("running")

      yield* Deferred.succeed(latch, undefined)
      expect((yield* jobs.wait({ id: job.id })).info?.output).toBe("done")
    }),
  )

  it.instance("runs promotion notification exactly once under concurrent callers", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const notifications = yield* Ref.make(0)
      const job = yield* jobs.start({
        type: "test",
        onPromote: Ref.update(notifications, (count) => count + 1),
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      const results = yield* Effect.all(
        Array.from({ length: 8 }, () => jobs.promote(job.id)),
        {
          concurrency: "unbounded",
        },
      )

      expect(results.every((result) => result?.metadata?.background === true)).toBe(true)
      expect(yield* Ref.get(notifications)).toBe(1)
      yield* Deferred.succeed(latch, undefined)
      expect((yield* jobs.wait({ id: job.id })).info?.status).toBe("completed")
    }),
  )

  it.instance("waitForPromotion resolves when a job is promoted", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const latch = yield* Deferred.make<void>()
      const job = yield* jobs.start({
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("done")),
      })

      const fiber = yield* jobs.waitForPromotion(job.id).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* jobs.promote(job.id)
      const promoted = yield* Fiber.join(fiber)

      expect(promoted.metadata?.background).toBe(true)
      yield* Deferred.succeed(latch, undefined)
    }),
  )

  it.live("interrupts running jobs when the instance is disposed", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()

      yield* Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        yield* jobs.start({
          type: "test",
          run: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          ),
        })
        yield* Deferred.await(started)
      }).pipe(withTmpdirInstance(), Effect.scoped)

      yield* Deferred.await(interrupted).pipe(Effect.timeout("1 second"))
    }),
  )
})
