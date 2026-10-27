import { Context, Effect, Layer, SynchronizedRef, TxReentrantLock } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import { SessionID } from "./schema"

const log = Log.create({ service: "session.history" })

export interface Interface {
  readonly withLock: <A, E, R>(sessionID: SessionID, work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionHistory") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    type Entry = { lock: TxReentrantLock.TxReentrantLock; users: number }
    const state = yield* InstanceState.make(() => SynchronizedRef.make(new Map<SessionID, Entry>()))
    const withLock: Interface["withLock"] = (sessionID, work) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const locks = yield* InstanceState.get(state)
          const entry = yield* SynchronizedRef.modifyEffect(
            locks,
            Effect.fnUntraced(function* (entries) {
              let entry = entries.get(sessionID)
              if (!entry) {
                entry = { lock: yield* TxReentrantLock.make(), users: 0 }
                entries.set(sessionID, entry)
              }
              entry.users += 1
              return [entry, entries] as const
            }),
          )
          log.info("mutation waiting", { sessionID })
          // Do not introduce a Scope here: runner admission forks work whose
          // lifetime must outlive the lock, especially interactive shells.
          return yield* restore(
            TxReentrantLock.withWriteLock(
              entry.lock,
              Effect.gen(function* () {
                log.info("mutation acquired", { sessionID })
                return yield* work.pipe(
                  Effect.ensuring(Effect.sync(() => log.info("mutation released", { sessionID }))),
                )
              }),
            ),
          ).pipe(
            Effect.ensuring(
              SynchronizedRef.update(locks, (entries) => {
                entry.users -= 1
                if (entry.users === 0) entries.delete(sessionID)
                return entries
              }),
            ),
          )
        }),
      )
    return Service.of({ withLock })
  }),
)

export const defaultLayer = layer
export * as SessionHistory from "./history"
