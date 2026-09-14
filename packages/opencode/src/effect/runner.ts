import { Cause, Deferred, Effect, Exit, Fiber, Latch, Schema, Scope, SynchronizedRef } from "effect"

export interface Runner<A, E = never> {
  readonly state: State<A, E>
  readonly busy: boolean
  readonly revision: number
  readonly ensureRunning: (work: Effect.Effect<A, E>, revision?: number) => Effect.Effect<A, E>
  readonly gracefulRestart: (work: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly startShell: (work: Effect.Effect<A, E>, ready?: Latch.Latch) => Effect.Effect<A, E | Busy>
  readonly cancel: Effect.Effect<void>
  readonly cancelWith: (cleanup: Effect.Effect<void>) => Effect.Effect<void>
}

export class Cancelled extends Schema.TaggedErrorClass<Cancelled>()("RunnerCancelled", {}) {}
export class Busy extends Schema.TaggedErrorClass<Busy>()("RunnerBusy", {}) {}

interface RunHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  fiber: Fiber.Fiber<A, E>
  /**
   * Set by gracefulRestart before interrupting the fiber so its exit handler
   * skips completing `done` — the restart owns it from then on and keeps
   * every coalesced caller attached to the replacement run.
   */
  abandoned?: boolean
}

interface ShellHandle<A, E> {
  id: number
  cancelled: Deferred.Deferred<void>
  ready?: Latch.Latch
  fiber: Fiber.Fiber<A, E>
}

interface PendingHandle<A, E> {
  id: number
  done: Deferred.Deferred<A, E | Cancelled>
  work: Effect.Effect<A, E>
}

export type State<A, E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly run: RunHandle<A, E> }
  | { readonly _tag: "Shell"; readonly shell: ShellHandle<A, E> }
  | { readonly _tag: "ShellThenRun"; readonly shell: ShellHandle<A, E>; readonly run: PendingHandle<A, E> }
  | { readonly _tag: "Stopping"; readonly done: Deferred.Deferred<void>; readonly restarting?: boolean }

export const make = <A, E = never>(
  scope: Scope.Scope,
  opts?: {
    onIdle?: Effect.Effect<void>
    onBusy?: Effect.Effect<void>
    onInterrupt?: Effect.Effect<A, E>
  },
): Runner<A, E> => {
  const ref = SynchronizedRef.makeUnsafe<State<A, E>>({ _tag: "Idle" })
  const idle = (opts?.onIdle ?? Effect.void).pipe(
    Effect.catchCause((cause) => Effect.logError("runner idle notification failed", cause)),
  )
  const onBusy = opts?.onBusy ?? Effect.void
  const onInterrupt = opts?.onInterrupt
  let ids = 0
  let revision = 0

  const state = () => SynchronizedRef.getUnsafe(ref)
  const next = () => {
    ids += 1
    return ids
  }

  const complete = (done: Deferred.Deferred<A, E | Cancelled>, exit: Exit.Exit<A, E | Cancelled>) =>
    Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
      ? Deferred.fail(done, new Cancelled()).pipe(Effect.asVoid)
      : Deferred.done(done, exit).pipe(Effect.asVoid)

  const awaitDone = (done: Deferred.Deferred<A, E | Cancelled>) =>
    Deferred.await(done).pipe(Effect.catchTag("RunnerCancelled", (e) => onInterrupt ?? Effect.die(e)))

  const finishRun = (run: RunHandle<A, E>, exit: Exit.Exit<A, E>) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Running" && st.run.id === run.id) yield* idle
        return [
          Effect.gen(function* () {
            if (run.abandoned) return
            yield* complete(run.done, exit)
          }),
          st._tag === "Running" && st.run.id === run.id ? ({ _tag: "Idle" } as const) : st,
        ] as const
      }),
    ).pipe(Effect.flatten)

  const startRun = (work: Effect.Effect<A, E>, done: Deferred.Deferred<A, E | Cancelled>) =>
    Effect.gen(function* () {
      const id = next()
      const run: RunHandle<A, E> = { id, done, fiber: undefined as unknown as Fiber.Fiber<A, E> }
      const fiber = yield* work.pipe(
        Effect.onExit((exit) => finishRun(run, exit)),
        Effect.forkIn(scope),
      )
      run.fiber = fiber
      return run
    })

  const finishShell = (id: number) =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag === "Shell" && st.shell.id === id) {
          return [idle, { _tag: "Idle" }] as const
        }
        if (st._tag === "ShellThenRun" && st.shell.id === id) {
          const run = yield* startRun(st.run.work, st.run.done)
          return [Effect.void, { _tag: "Running", run }] as const
        }
        return [Effect.void, st] as const
      }),
    ).pipe(Effect.flatten)

  const stopShell = (shell: ShellHandle<A, E>) =>
    Effect.gen(function* () {
      if (shell.ready) yield* shell.ready.await.pipe(Effect.exit, Effect.asVoid)
      yield* Deferred.succeed(shell.cancelled, undefined).pipe(Effect.asVoid)
      yield* Fiber.interrupt(shell.fiber)
    })

  const ensureRunning = (work: Effect.Effect<A, E>, expectedRevision = revision): Effect.Effect<A, E> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (expectedRevision !== revision) return [onInterrupt ?? Effect.interrupt, st] as const
        switch (st._tag) {
          case "Stopping":
            return [
              Deferred.await(st.done).pipe(Effect.flatMap(() => ensureRunning(work, expectedRevision))),
              st,
            ] as const
          case "Running":
          case "ShellThenRun":
            return [awaitDone(st.run.done), st] as const
          case "Shell": {
            const run = {
              id: next(),
              done: yield* Deferred.make<A, E | Cancelled>(),
              work,
            } satisfies PendingHandle<A, E>
            return [awaitDone(run.done), { _tag: "ShellThenRun", shell: st.shell, run }] as const
          }
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  // Interrupt the in-flight run and start replacement work, keeping every
  // caller already coalesced on the interrupted run attached to the
  // replacement: they receive its final result instead of unwinding with a
  // cancellation. A no-op restart when idle (equivalent to ensureRunning).
  //
  // The modifyEffect body runs while holding the ref's permit, so it must
  // never await a fiber whose exit handler re-enters the ref (deadlock). All
  // blocking work lives in the returned effect, which runs after the permit
  // is released.
  const gracefulRestart = (work: Effect.Effect<A, E>, expectedRevision = revision): Effect.Effect<A, E> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (expectedRevision !== revision) return [onInterrupt ?? Effect.interrupt, st] as const
        switch (st._tag) {
          case "Stopping":
            return [
              Deferred.await(st.done).pipe(Effect.flatMap(() => gracefulRestart(work, expectedRevision))),
              st,
            ] as const
          case "Idle": {
            const done = yield* Deferred.make<A, E | Cancelled>()
            const run = yield* startRun(work, done)
            return [awaitDone(done), { _tag: "Running", run }] as const
          }
          case "Shell":
          case "ShellThenRun":
            // Shells keep their dedicated cancel semantics: stop the shell and
            // fail any queued run so existing callers unwind, then start the
            // replacement work fresh.
            return [
              Effect.gen(function* () {
                yield* cancel
                return yield* ensureRunning(work)
              }),
              st,
            ] as const
          case "Running": {
            const old = st.run
            old.abandoned = true
            const done = yield* Deferred.make<void>()
            const replacement = yield* Effect.gen(function* () {
              yield* Fiber.interrupt(old.fiber).pipe(
                Effect.ensuring(
                  SynchronizedRef.modifyEffect(
                    ref,
                    Effect.fnUntraced(function* () {
                      yield* idle
                      Deferred.doneUnsafe(done, Exit.void)
                      return [undefined, { _tag: "Idle" } as const] as const
                    }),
                  ),
                ),
              )
              const exit = yield* ensureRunning(work, expectedRevision).pipe(Effect.exit)
              yield* complete(old.done, exit)
              return yield* awaitDone(old.done)
            }).pipe(
              Effect.onExit((exit) => complete(old.done, exit)),
              Effect.forkIn(scope),
            )
            return [Fiber.join(replacement), { _tag: "Stopping", done, restarting: true }] as const
          }
        }
      }),
    ).pipe(Effect.flatten)

  const startShell = (work: Effect.Effect<A, E>, ready?: Latch.Latch): Effect.Effect<A, E | Busy> =>
    SynchronizedRef.modifyEffect(
      ref,
      Effect.fnUntraced(function* (st) {
        if (st._tag !== "Idle") {
          const reject: Effect.Effect<A, E | Busy> = Effect.fail(new Busy())
          return [reject, st] as const
        }
        yield* onBusy
        const id = next()
        const cancelled = yield* Deferred.make<void>()
        const fiber = yield* work.pipe(Effect.ensuring(finishShell(id)), Effect.forkChild)
        const shell = { id, cancelled, ready, fiber } satisfies ShellHandle<A, E>
        return [
          Effect.gen(function* () {
            const exit = yield* Fiber.await(fiber)
            if (Exit.isSuccess(exit)) return exit.value
            if (
              Cause.hasInterruptsOnly(exit.cause) ||
              ((yield* Deferred.isDone(cancelled)) && Cause.hasInterrupts(exit.cause) && !Cause.hasDies(exit.cause))
            ) {
              if (onInterrupt) return yield* onInterrupt
              return yield* Effect.die(new Cancelled())
            }
            return yield* Effect.failCause(exit.cause)
          }),
          { _tag: "Shell", shell },
        ] as const
      }),
    ).pipe(Effect.flatten)

  const cancelWith = (cleanup: Effect.Effect<void>): Effect.Effect<void> =>
    Effect.uninterruptible(
      SynchronizedRef.modify(ref, (st) => {
        if (st._tag === "Stopping") {
          if (!st.restarting) return [Deferred.await(st.done), st] as const
          revision += 1
          return [Deferred.await(st.done).pipe(Effect.andThen(Effect.suspend(() => cancelWith(cleanup)))), st] as const
        }
        revision += 1
        const done = Deferred.makeUnsafe<void>()
        const finish = SynchronizedRef.modifyEffect(
          ref,
          Effect.fnUntraced(function* (current) {
            yield* idle
            Deferred.doneUnsafe(done, Exit.void)
            return [undefined, { _tag: "Idle" } as const] as const
          }),
        )
        const stop = (work: Effect.Effect<void>) =>
          Effect.logInfo("runner stopping", { revision, previous: st._tag }).pipe(
            Effect.andThen(work),
            Effect.andThen(Effect.logInfo("runner task stopped; business cleanup start", { revision })),
            Effect.andThen(cleanup),
            Effect.ensuring(finish),
          )
        switch (st._tag) {
          case "Idle":
            return [stop(Effect.void), { _tag: "Stopping", done }] as const
          case "Running":
            return [
              stop(
                Effect.gen(function* () {
                  yield* Fiber.interrupt(st.run.fiber)
                  yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
                }),
              ),
              { _tag: "Stopping", done } as const,
            ] as const
          case "Shell":
            return [
              stop(
                Effect.gen(function* () {
                  yield* stopShell(st.shell)
                }),
              ),
              { _tag: "Stopping", done } as const,
            ] as const
          case "ShellThenRun":
            return [
              stop(
                Effect.gen(function* () {
                  yield* stopShell(st.shell)
                  yield* Deferred.fail(st.run.done, new Cancelled()).pipe(Effect.asVoid)
                }),
              ),
              { _tag: "Stopping", done } as const,
            ] as const
        }
      }).pipe(Effect.flatten),
    )
  const cancel = cancelWith(Effect.void)

  return {
    get state() {
      return state()
    },
    get busy() {
      return state()._tag !== "Idle"
    },
    get revision() {
      return revision
    },
    ensureRunning,
    gracefulRestart,
    startShell,
    cancel,
    cancelWith,
  }
}

export * as Runner from "./runner"
