import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { InstanceRef } from "@/effect/instance-ref"
import { serviceUse } from "@/effect/service-use"
import { Identifier } from "@/id/id"
import { errorMessage } from "@/util/error"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Context, Duration, Effect, Exit, Fiber, Layer, Schema, Scope, SynchronizedRef } from "effect"
import { InstanceStore } from "./instance-store"
import * as ProjectLocation from "./location"
import type { LocationID } from "./schema"

export class LocationNotFound extends Schema.TaggedErrorClass<LocationNotFound>()(
  "LocationLifecycle.LocationNotFound",
  { locationID: Schema.String },
) {}

export class LocationUnavailable extends Schema.TaggedErrorClass<LocationUnavailable>()(
  "LocationLifecycle.LocationUnavailable",
  { directory: Schema.String },
) {}

export class LocationDeleting extends Schema.TaggedErrorClass<LocationDeleting>()(
  "LocationLifecycle.LocationDeleting",
  { directory: Schema.String },
) {}

export class LocationDeleted extends Schema.TaggedErrorClass<LocationDeleted>()("LocationLifecycle.LocationDeleted", {
  directory: Schema.String },
) {}

export class LocationBusy extends Schema.TaggedErrorClass<LocationBusy>()("LocationLifecycle.LocationBusy", {
  directory: Schema.String,
  leases: Schema.Number,
}) {}

export class LocationGenerationMismatch extends Schema.TaggedErrorClass<LocationGenerationMismatch>()(
  "LocationLifecycle.LocationGenerationMismatch",
  { directory: Schema.String, expected: Schema.Number, actual: Schema.Number },
) {}

export class LocationDeleteFailed extends Schema.TaggedErrorClass<LocationDeleteFailed>()(
  "LocationLifecycle.LocationDeleteFailed",
  { directory: Schema.String, operation: Schema.String, message: Schema.String },
) {}

export type AdmissionError = LocationUnavailable | LocationDeleting | LocationDeleted

export type DeleteLocationError = LocationBusy | LocationDeleteFailed

export type AdmissionPurpose = "http-request" | "session-run" | "scheduled-task" | "pty" | "background-job"

export type LifecycleState = "available" | "unavailable" | "deleting" | "deleted"

export type RuntimeState =
  | { readonly tag: "stopped" }
  | { readonly tag: "starting"; readonly leases: number }
  | { readonly tag: "running"; readonly leases: number }
  | { readonly tag: "stopping" }

export interface LocationSnapshot {
  readonly locationID?: LocationID
  readonly directory: string
  readonly lifecycle: LifecycleState
  readonly generation: number
  readonly runtime: RuntimeState
}

export interface DeleteLocationInput {
  readonly directory: string
  readonly operationID?: string
  readonly removeFileSystem?: Effect.Effect<void, Error>
}

export interface DeleteLocationResult {
  readonly locationID?: LocationID
  readonly operationID: string
  readonly generation: number
}

export interface Interface {
  readonly provide: <A, E, R>(
    input: {
      directory: string
      purpose: AdmissionPurpose
    },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AdmissionError, R>

  readonly delete: (input: DeleteLocationInput) => Effect.Effect<DeleteLocationResult, DeleteLocationError>

  readonly recoverDeleting: () => Effect.Effect<void>

  readonly snapshot: (locationID: LocationID) => Effect.Effect<LocationSnapshot, LocationNotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationLifecycle") {}

export const use = serviceUse(Service)

const admissionTags = new Set<string>([
  "LocationLifecycle.LocationUnavailable",
  "LocationLifecycle.LocationDeleting",
  "LocationLifecycle.LocationDeleted",
])

const isAdmissionError = (error: unknown): error is AdmissionError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  admissionTags.has((error as { _tag: unknown })._tag as string)

/**
 * Hold a lease on `input.directory` for the duration of `effect`.
 *
 * Long-running instance internals (session runs, PTYs, background jobs) call
 * this instead of depending on `Service` directly, so bare unit-test layers
 * without the lifecycle gate keep working unleased. When the service is
 * present, admission is enforced; rejection means the location vanished while
 * the caller was already inside it, so admission errors are re-raised as
 * defects.
 */
export const lease = <A, E, R>(
  input: { directory: string; purpose: AdmissionPurpose },
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.serviceOption(Service).pipe(
    Effect.flatMap((service) =>
      service._tag === "None"
        ? effect
        : service.value
            .provide(input, effect)
            // catchIf with a refinement keeps the generic handler error E
            // intact, which catchTags cannot express here.
            .pipe(Effect.catchIf(isAdmissionError, (error) => Effect.die(error))),
    ),
  )

interface EntryState {
  readonly lifecycle: LifecycleState
  readonly generation: number
  readonly runtime: RuntimeState
  readonly locationID?: LocationID
}

interface Entry {
  readonly directory: string
  readonly ref: SynchronizedRef.SynchronizedRef<EntryState>
}

const stopped: RuntimeState = { tag: "stopped" }

export const config = {
  idleDisposalMs: 120_000,
}

export const layer: Layer.Layer<Service, never, InstanceStore.Service | AppFileSystem.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const fs = yield* AppFileSystem.Service
    const scope = yield* Scope.Scope
    const entries = new Map<string, Entry>()
    const idleTimers = new Map<string, Fiber.Fiber<void, unknown>>()

    const entryFor = (directory: string) =>
      Effect.sync(() => {
        const existing = entries.get(directory)
        if (existing) return existing
        // Sync with DB: a deleting/deleted row from a previous process must
        // block new admissions immediately.
        const row = ProjectLocation.getByCanonicalDirectory(directory)
        const created: Entry = {
          directory,
          ref: SynchronizedRef.makeUnsafe<EntryState>({
            lifecycle: row?.lifecycle.state ?? "available",
            generation: row?.lifecycle.generation ?? 0,
            runtime: stopped,
            locationID: row?.id,
          }),
        }
        entries.set(directory, created)
        return created
      })

    const log = (line: string) => Effect.logInfo(line).pipe(Effect.annotateLogs("module", "location-lifecycle"))

    const cancelIdleTimer = (directory: string) =>
      Effect.gen(function* () {
        const existing = idleTimers.get(directory)
        if (!existing) return
        idleTimers.delete(directory)
        yield* Fiber.interrupt(existing).pipe(Effect.ignore)
        yield* log(`[location-lifecycle] idle-cancelled location=${directory} reason=new-lease`)
      })

    const scheduleIdleDisposal = (entry: Entry, generation: number) =>
      Effect.gen(function* () {
        yield* cancelIdleTimer(entry.directory)
        const timer = Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(config.idleDisposalMs))
          const state = yield* SynchronizedRef.get(entry.ref)
          if (state.generation !== generation) return
          if (state.lifecycle !== "available") return
          if (state.runtime.tag !== "running") return
          if (state.runtime.leases !== 0) return
          yield* SynchronizedRef.modify(entry.ref, (s): readonly [void, EntryState] => [
            undefined,
            { ...s, runtime: { tag: "stopping" } },
          ])
          yield* Effect.promise(() => runDisposers(entry.directory)).pipe(Effect.ignore)
          yield* SynchronizedRef.modify(entry.ref, (s): readonly [void, EntryState] => [
            undefined,
            { ...s, runtime: stopped },
          ])
          idleTimers.delete(entry.directory)
          yield* log(
            `[location-lifecycle] runtime-disposed location=${entry.directory} generation=${generation} reason=idle`,
          )
        })
        const fiber = yield* timer.pipe(Effect.forkIn(scope))
        idleTimers.set(entry.directory, fiber)
        yield* log(
          `[location-lifecycle] idle-scheduled location=${entry.directory} generation=${generation} delayMs=${config.idleDisposalMs}`,
        )
      })

    const provide = <A, E, R>(
      input: { directory: string; purpose: AdmissionPurpose },
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | AdmissionError, R> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = yield* entryFor(directory)

          // Sync lifecycle state with DB: the DB might have been modified
          // externally (e.g. a crashed delete, or direct markDeleting).
          const dbRow = ProjectLocation.getByCanonicalDirectory(directory)
          if (dbRow && dbRow.lifecycle.state !== "available") {
            yield* SynchronizedRef.modify(entry.ref, (state): readonly [void, EntryState] => [
              undefined,
              {
                ...state,
                lifecycle: dbRow.lifecycle.state,
                generation: dbRow.lifecycle.generation,
                locationID: dbRow.id,
              },
            ])
          }

          const current = yield* SynchronizedRef.get(entry.ref)
          yield* log(
            `[location-lifecycle] admission-request location=${directory} generation=${current.generation} purpose=${input.purpose}`,
          )

          const admission = yield* SynchronizedRef.modify(
            entry.ref,
            (state): readonly [
              { ok: true; generation: number; leases: number } | { ok: false; error: AdmissionError },
              EntryState,
            ] => {
              if (state.lifecycle === "deleting") {
                return [{ ok: false, error: new LocationDeleting({ directory }) }, state]
              }
              if (state.lifecycle === "deleted") {
                return [{ ok: false, error: new LocationDeleted({ directory }) }, state]
              }
              if (state.lifecycle === "unavailable") {
                return [{ ok: false, error: new LocationUnavailable({ directory }) }, state]
              }
              if (state.runtime.tag === "stopping") {
                return [{ ok: false, error: new LocationUnavailable({ directory }) }, state]
              }
              const runtime: RuntimeState =
                state.runtime.tag === "stopped"
                  ? { tag: "starting", leases: 1 }
                  : { ...state.runtime, leases: state.runtime.leases + 1 }
              return [
                { ok: true, generation: state.generation, leases: runtime.leases },
                { ...state, runtime },
              ]
            },
          )
          if (!admission.ok) return yield* admission.error
          const { generation } = admission

          // Cancel any pending idle disposal timer — a new lease makes it a no-op
          yield* cancelIdleTimer(directory)

          yield* log(
            `[location-lifecycle] lease-acquired location=${directory} generation=${generation} purpose=${input.purpose} leases=${admission.leases}`,
          )

          const release = SynchronizedRef.modify(
            entry.ref,
            (state): readonly [{ leases: number; runtimeTag: string }, EntryState] => {
              const runtime = state.runtime
              if (runtime.tag === "stopped" || runtime.tag === "stopping")
                return [{ leases: 0, runtimeTag: runtime.tag }, state]
              const leases = Math.max(0, runtime.leases - 1)
              // A failed start with no remaining leases resets to stopped so a
              // later admission may retry. A running runtime stays up when it
              // goes idle; idle disposal is scheduled below.
              const next: RuntimeState =
                leases === 0 && runtime.tag === "starting" ? stopped : { ...runtime, leases }
              return [{ leases, runtimeTag: next.tag }, { ...state, runtime: next }]
            },
          )

          const run = Effect.gen(function* () {
            if (!(yield* fs.existsSafe(directory))) {
              return yield* new LocationUnavailable({ directory })
            }
            const ctx = yield* store.load({ directory })

            type Mark = "started" | "already" | { readonly tag: "stale"; readonly actual: number }
            const started = yield* SynchronizedRef.modify(entry.ref, (state): readonly [Mark, EntryState] => {
              if (state.generation !== generation) {
                // A stale generation must not publish a started runtime. The
                // generation only moves when deletion increments it.
                return [{ tag: "stale", actual: state.generation }, state]
              }
              if (state.runtime.tag !== "starting") return ["already", { ...state, locationID: ctx.location.id }]
              return [
                "started",
                {
                  ...state,
                  runtime: { tag: "running", leases: state.runtime.leases },
                  locationID: ctx.location.id,
                },
              ]
            })
            if (typeof started !== "string") {
              return yield* Effect.die(
                new LocationGenerationMismatch({ directory, expected: generation, actual: started.actual }),
              )
            }
            if (started === "started") {
              yield* log(`[location-lifecycle] runtime-started location=${directory} generation=${generation}`)
            }

            return yield* restore(effect).pipe(Effect.provideService(InstanceRef, ctx))
          })

          return yield* restore(run).pipe(
            Effect.ensuring(
              release.pipe(
                Effect.flatMap(({ leases, runtimeTag }) =>
                  Effect.gen(function* () {
                    yield* log(
                      `[location-lifecycle] lease-released location=${directory} generation=${generation} purpose=${input.purpose} leases=${leases}`,
                    )
                    if (leases === 0 && runtimeTag === "running") {
                      yield* scheduleIdleDisposal(entry, generation)
                    }
                  }),
                ),
              ),
            ),
          )
        }),
      ).pipe(Effect.withSpan("LocationLifecycle.provide"))
    }

    const deleteLocation = (input: DeleteLocationInput): Effect.Effect<DeleteLocationResult, DeleteLocationError> => {
      const directory = AppFileSystem.resolve(input.directory)
      const operationID = input.operationID ?? Identifier.create("delop", "ascending")
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = yield* entryFor(directory)
          const current = yield* SynchronizedRef.get(entry.ref)

          yield* log(
            `[location-lifecycle] delete-request location=${directory} generation=${current.generation} operation=${operationID}`,
          )

          // Sync in-memory state with DB (the DB might have been modified
          // externally, e.g. a crashed delete from a previous process).
          const row = ProjectLocation.getByCanonicalDirectory(directory)
          if (row && row.lifecycle.state !== current.lifecycle) {
            yield* SynchronizedRef.modify(entry.ref, (state): readonly [void, EntryState] => [
              undefined,
              { ...state, lifecycle: row.lifecycle.state, generation: row.lifecycle.generation, locationID: row.id },
            ])
          }
          const synced = yield* SynchronizedRef.get(entry.ref)

          // Idempotent: already deleted → success
          if (synced.lifecycle === "deleted") {
            yield* log(
              `[location-lifecycle] delete-idempotent location=${directory} generation=${synced.generation} operation=${operationID} result=already-deleted`,
            )
            return {
              locationID: synced.locationID,
              operationID,
              generation: synced.generation,
            }
          }

          // Already deleting: same operationID = retry, different = conflict
          if (synced.lifecycle === "deleting") {
            const existing = row?.lifecycle.deleteOperationID
            if (existing && existing !== operationID) {
              return yield* new LocationDeleteFailed({
                directory,
                operation: "delete",
                message: `Location is already being deleted by operation ${existing}`,
              })
            }
            // Same operation ID → fall through to retry the deletion work
          }

          // Fail-if-busy: active leases block deletion
          if (synced.runtime.tag === "running" && synced.runtime.leases > 0) {
            return yield* new LocationBusy({ directory, leases: synced.runtime.leases })
          }
          if (synced.runtime.tag === "starting" && synced.runtime.leases > 0) {
            return yield* new LocationBusy({ directory, leases: synced.runtime.leases })
          }

          // Cancel any pending idle disposal timer
          yield* cancelIdleTimer(directory)

          // Persist lifecycle_state=deleting + increment generation
          let locationID = synced.locationID
          let generation = synced.generation
          if (row) {
            const updated = ProjectLocation.markDeleting({ directory, operationID })
            if (updated) {
              locationID = updated.id
              generation = updated.lifecycle.generation
            }
          }

          // Update in-memory state to deleting (blocks new admissions)
          yield* SynchronizedRef.modify(entry.ref, (state): readonly [void, EntryState] => [
            undefined,
            { ...state, lifecycle: "deleting", generation, locationID },
          ])

          yield* log(
            `[location-lifecycle] delete-fenced location=${directory} generation=${generation} operation=${operationID}`,
          )

          // Dispose runtime if running or starting
          if (synced.runtime.tag === "running" || synced.runtime.tag === "starting") {
            yield* SynchronizedRef.modify(entry.ref, (state): readonly [void, EntryState] => [
              undefined,
              { ...state, runtime: { tag: "stopping" } },
            ])
            yield* Effect.promise(() => runDisposers(directory)).pipe(Effect.ignore)
            yield* SynchronizedRef.modify(entry.ref, (state): readonly [void, EntryState] => [
              undefined,
              { ...state, runtime: stopped },
            ])
            yield* log(
              `[location-lifecycle] runtime-disposed location=${directory} generation=${generation} reason=delete`,
            )
          }

          // Run filesystem adapter (git worktree removal, directory cleanup)
          if (input.removeFileSystem) {
            yield* input.removeFileSystem.pipe(
              Effect.mapError(
                (error) =>
                  new LocationDeleteFailed({
                    directory,
                    operation: "remove-file-system",
                    message: errorMessage(error) || "Filesystem removal failed",
                  }),
              ),
            )
          }

          // Persist lifecycle_state=deleted
          if (row) {
            ProjectLocation.markDeleted({ directory })
          }

          // Update in-memory state to deleted
          yield* SynchronizedRef.modify(entry.ref, (state): readonly [void, EntryState] => [
            undefined,
            { ...state, lifecycle: "deleted" as const, runtime: stopped, locationID, generation },
          ])

          yield* log(
            `[location-lifecycle] delete-completed location=${directory} generation=${generation} operation=${operationID}`,
          )

          return { locationID, operationID, generation }
        }),
      ).pipe(Effect.withSpan("LocationLifecycle.delete"))
    }

    const recoverDeleting = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const rows = ProjectLocation.listByLifecycleState("deleting")
        for (const row of rows) {
          const exists = yield* fs.existsSafe(row.canonicalDirectory)
          if (!exists) {
            // Directory is absent → finish the tombstone
            ProjectLocation.markDeleted({ directory: row.canonicalDirectory })
            yield* log(
              `[location-lifecycle] delete-recovered location=${row.canonicalDirectory} generation=${row.lifecycle.generation} result=deleted`,
            )
          } else {
            // Directory remains → keep the fence; entryFor will pick up
            // lifecycle=deleting from the DB when the location is next touched.
            yield* log(
              `[location-lifecycle] delete-pending location=${row.canonicalDirectory} generation=${row.lifecycle.generation} result=fenced`,
            )
          }
        }
      })

    const snapshot = (locationID: LocationID): Effect.Effect<LocationSnapshot, LocationNotFound> =>
      Effect.gen(function* () {
        for (const entry of entries.values()) {
          const state = yield* SynchronizedRef.get(entry.ref)
          if (state.locationID !== locationID) continue
          return {
            locationID: state.locationID,
            directory: entry.directory,
            lifecycle: state.lifecycle,
            generation: state.generation,
            runtime: state.runtime,
          }
        }
        return yield* new LocationNotFound({ locationID })
      })

    // Startup recovery: finish tombstones for deleting rows whose directories
    // are gone, and keep the fence for those that still exist.
    const recoveryExit = yield* Effect.exit(recoverDeleting())
    if (Exit.isFailure(recoveryExit)) {
      yield* log(`[location-lifecycle] recovery-error`)
    }

    // Shutdown: cancel all idle timers
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const [, fiber] of idleTimers) {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        }
        idleTimers.clear()
      }),
    )

    return Service.of({
      provide,
      delete: deleteLocation,
      recoverDeleting,
      snapshot,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(InstanceStore.defaultLayer, AppFileSystem.defaultLayer)),
)

export * as LocationLifecycle from "./location-lifecycle"
