import { InstanceRef } from "@/effect/instance-ref"
import { serviceUse } from "@/effect/service-use"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Context, Effect, Layer, Schema, SynchronizedRef } from "effect"
import { InstanceStore } from "./instance-store"
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

export interface Interface {
  readonly provide: <A, E, R>(
    input: {
      directory: string
      purpose: AdmissionPurpose
    },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AdmissionError, R>

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

export const layer: Layer.Layer<Service, never, InstanceStore.Service | AppFileSystem.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const fs = yield* AppFileSystem.Service
    const entries = new Map<string, Entry>()

    const entryFor = (directory: string) =>
      Effect.sync(() => {
        const existing = entries.get(directory)
        if (existing) return existing
        const created: Entry = {
          directory,
          ref: SynchronizedRef.makeUnsafe<EntryState>({
            lifecycle: "available",
            generation: 0,
            runtime: stopped,
          }),
        }
        entries.set(directory, created)
        return created
      })

    const log = (line: string) => Effect.logInfo(line).pipe(Effect.annotateLogs("module", "location-lifecycle"))

    const provide = <A, E, R>(
      input: { directory: string; purpose: AdmissionPurpose },
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | AdmissionError, R> => {
      const directory = AppFileSystem.resolve(input.directory)
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = yield* entryFor(directory)

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

          yield* log(
            `[location-lifecycle] lease-acquired location=${directory} generation=${generation} purpose=${input.purpose} leases=${admission.leases}`,
          )

          const release = SynchronizedRef.modify(entry.ref, (state): readonly [number, EntryState] => {
            const runtime = state.runtime
            if (runtime.tag === "stopped" || runtime.tag === "stopping") return [0, state]
            const leases = Math.max(0, runtime.leases - 1)
            // A failed start with no remaining leases resets to stopped so a
            // later admission may retry. A running runtime stays up when it
            // goes idle; idle disposal arrives with the ownership cutover.
            const next: RuntimeState = leases === 0 && runtime.tag === "starting" ? stopped : { ...runtime, leases }
            return [leases, { ...state, runtime: next }]
          })

          const run = Effect.gen(function* () {
            if (!(yield* fs.existsSafe(directory))) {
              return yield* new LocationUnavailable({ directory })
            }
            const ctx = yield* store.load({ directory })

            type Mark = "started" | "already" | { readonly tag: "stale"; readonly actual: number }
            const started = yield* SynchronizedRef.modify(entry.ref, (state): readonly [Mark, EntryState] => {
              if (state.generation !== generation) {
                // A stale generation must not publish a started runtime. The
                // generation only moves once deletion/reload land; until then
                // this branch is unreachable.
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
                Effect.flatMap((leases) =>
                  log(
                    `[location-lifecycle] lease-released location=${directory} generation=${generation} purpose=${input.purpose} leases=${leases}`,
                  ),
                ),
              ),
            ),
          )
        }),
      ).pipe(Effect.withSpan("LocationLifecycle.provide"))
    }

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

    return Service.of({
      provide,
      snapshot,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(InstanceStore.defaultLayer, AppFileSystem.defaultLayer)),
)

export * as LocationLifecycle from "./location-lifecycle"
