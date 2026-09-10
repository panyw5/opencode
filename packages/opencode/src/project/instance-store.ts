import { GlobalBus } from "@/bus/global"
import { serviceUse } from "@/effect/service-use"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance as runDisposers } from "@/effect/instance-registry"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Path, type LogicalPath, type NativePath, type PathIdentity } from "@opencode-ai/core/util/path"
import { Context, Deferred, Duration, Effect, Exit, Layer, Scope } from "effect"
import { localPathContext, type InstanceContext } from "./instance-context"
import { InstanceBootstrap } from "./bootstrap-service"
import * as Project from "./project"
import type { ProjectLocation } from "./location"

export interface LoadInput {
  directory: string
  worktree?: string
  project?: Project.Info
  location?: ProjectLocation.Info
  registration?: Project.Registration
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly reload: (input: LoadInput) => Effect.Effect<InstanceContext>
  readonly dispose: (ctx: InstanceContext) => Effect.Effect<void>
  readonly disposeAll: () => Effect.Effect<void>
  readonly provide: <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstanceStore") {}

export const use = serviceUse(Service)

interface Entry {
  readonly deferred: Deferred.Deferred<InstanceContext>
}

type NormalizedDirectory = {
  readonly raw: string
  readonly logical: LogicalPath
  readonly identity: PathIdentity
  readonly native: NativePath
}

type BootInput = Omit<LoadInput, "directory"> & { directory: NormalizedDirectory }

function normalizeDirectory(input: string): NormalizedDirectory {
  const logical = Path.logical(input, localPathContext)
  return {
    raw: input,
    logical,
    identity: Path.identity(logical, localPathContext),
    native: Path.native(logical, localPathContext),
  }
}

export const layer: Layer.Layer<Service, never, Project.Service | InstanceBootstrap.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const project = yield* Project.Service
    const bootstrap = yield* InstanceBootstrap.Service
    const scope = yield* Scope.Scope
    const cache = new Map<PathIdentity, Entry>()

    const boot = (input: BootInput) =>
      Effect.gen(function* () {
        const ctx: InstanceContext =
          input.project && input.worktree && input.location
            ? {
                directory: input.directory.logical,
                directoryKey: input.directory.identity,
                nativeDirectory: input.directory.native,
                worktree: Path.logical(input.worktree, localPathContext),
                project: input.project,
                location: input.location,
              }
            : yield* project.fromDirectory(input.directory.native, input.registration).pipe(
                Effect.map((result) => ({
                  directory: input.directory.logical,
                  directoryKey: input.directory.identity,
                  nativeDirectory: input.directory.native,
                  worktree: Path.logical(result.sandbox, localPathContext),
                  project: result.project,
                  location: result.location,
                })),
              )
        yield* bootstrap.run.pipe(Effect.provideService(InstanceRef, ctx))
        return ctx
      }).pipe(Effect.withSpan("InstanceStore.boot"))

    const removeEntry = (directoryKey: PathIdentity, entry: Entry) =>
      Effect.sync(() => {
        if (cache.get(directoryKey) !== entry) return false
        cache.delete(directoryKey)
        return true
      })

    const applyRegistration = Effect.fn("InstanceStore.applyRegistration")(function* (
      ctx: InstanceContext,
      registration?: Project.Registration,
    ) {
      if (registration?.visibility === "internal") {
        const current = yield* project.get(ctx.project.id)
        return current && current.visibility !== ctx.project.visibility ? { ...ctx, project: current } : ctx
      }
      if (ctx.project.visibility === "user") return ctx
      const visible = yield* project.ensureUserVisible(ctx.project.id)
      if (!visible) return ctx
      yield* Effect.logInfo("instance project visibility refreshed").pipe(
        Effect.annotateLogs({ directory: ctx.directory, projectID: ctx.project.id, kind: visible.kind }),
      )
      return { ...ctx, project: visible }
    })

    const completeLoad = (directoryKey: PathIdentity, input: LoadInput, entry: Entry, directory: NormalizedDirectory) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(boot({ ...input, directory }))
        if (Exit.isFailure(exit)) yield* removeEntry(directoryKey, entry)
        yield* Deferred.done(entry.deferred, exit).pipe(Effect.asVoid)
      })

    const emitDisposed = (input: { directory: string; project?: string }) =>
      Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: input.directory,
          project: input.project,
          workspace: WorkspaceContext.workspaceID,
          payload: {
            type: "server.instance.disposed",
            properties: {
              directory: input.directory,
            },
          },
        }),
      )

    const disposeContext = Effect.fn("InstanceStore.disposeContext")(function* (ctx: InstanceContext) {
      yield* Effect.logInfo("instance-disposed").pipe(
        Effect.annotateLogs({
          rawPath: ctx.directory,
          logicalPath: ctx.directory,
          identityKey: ctx.directoryKey,
          instanceID: ctx.directoryKey,
          nativePath: ctx.nativeDirectory,
          platform: localPathContext.platform,
          workspaceKind: localPathContext.kind,
          projectID: ctx.project.id,
        }),
      )
      yield* Effect.promise(() => runDisposers(ctx.directoryKey))
      yield* emitDisposed({ directory: ctx.directory, project: ctx.project.id })
    })

    const disposeEntry = Effect.fnUntraced(function* (directoryKey: PathIdentity, entry: Entry, ctx: InstanceContext) {
      if (cache.get(directoryKey) !== entry) return false
      yield* disposeContext(ctx)
      if (cache.get(directoryKey) !== entry) return false
      cache.delete(directoryKey)
      return true
    })

    const load = (input: LoadInput): Effect.Effect<InstanceContext> => {
      // AppFileSystem.resolve owns compatibility parsing for /mnt/<drive>,
      // /cygdrive/<drive> and /<drive> inputs on Windows. Converting to native
      // separators before that boundary would destroy those prefixes.
      const directory = normalizeDirectory(AppFileSystem.resolve(input.directory))
      const directoryKey = directory.identity
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const existing = cache.get(directoryKey)
          if (existing) {
            yield* Effect.logInfo("instance-reused").pipe(
              Effect.annotateLogs({
                rawPath: input.directory,
                logicalPath: directory.logical,
                identityKey: directory.identity,
                instanceID: directory.identity,
                nativePath: directory.native,
                platform: localPathContext.platform,
                workspaceKind: localPathContext.kind,
              }),
            )
            const ctx = yield* restore(Deferred.await(existing.deferred))
            return yield* applyRegistration(ctx, input.registration)
          }

          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directoryKey, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("instance-created").pipe(
              Effect.annotateLogs({
                rawPath: input.directory,
                logicalPath: directory.logical,
                identityKey: directory.identity,
                instanceID: directory.identity,
                nativePath: directory.native,
                platform: localPathContext.platform,
                workspaceKind: localPathContext.kind,
              }),
            )
            yield* completeLoad(directoryKey, input, entry, directory)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          const ctx = yield* restore(Deferred.await(entry.deferred))
          return yield* applyRegistration(ctx, input.registration)
        }),
      ).pipe(Effect.withSpan("InstanceStore.load"))
    }

    const reload = (input: LoadInput): Effect.Effect<InstanceContext> => {
      const directory = normalizeDirectory(AppFileSystem.resolve(input.directory))
      const directoryKey = directory.identity
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const previous = cache.get(directoryKey)
          const entry: Entry = { deferred: Deferred.makeUnsafe<InstanceContext>() }
          cache.set(directoryKey, entry)
          yield* Effect.gen(function* () {
            yield* Effect.logInfo("instance-created").pipe(
              Effect.annotateLogs({
                rawPath: input.directory,
                logicalPath: directory.logical,
                identityKey: directory.identity,
                instanceID: directory.identity,
                nativePath: directory.native,
                platform: localPathContext.platform,
                workspaceKind: localPathContext.kind,
                reload: true,
              }),
            )
            if (previous) {
              yield* Deferred.await(previous.deferred).pipe(Effect.ignore)
              yield* Effect.promise(() => runDisposers(directoryKey))
              yield* emitDisposed({ directory: directory.logical, project: input.project?.id })
            }
            yield* completeLoad(directoryKey, input, entry, directory)
          }).pipe(Effect.forkIn(scope, { startImmediately: true }))
          return yield* restore(Deferred.await(entry.deferred))
        }),
      ).pipe(Effect.withSpan("InstanceStore.reload"))
    }

    const dispose = Effect.fn("InstanceStore.dispose")(function* (ctx: InstanceContext) {
      const entry = cache.get(ctx.directoryKey)
      if (!entry) return yield* disposeContext(ctx)

      const exit = yield* Deferred.await(entry.deferred).pipe(Effect.exit)
      if (Exit.isFailure(exit)) return yield* removeEntry(ctx.directoryKey, entry).pipe(Effect.asVoid)
      if (exit.value !== ctx) return
      yield* disposeEntry(ctx.directoryKey, entry, ctx).pipe(Effect.asVoid)
    })

    const disposeAllOnce = Effect.fnUntraced(function* () {
      yield* Effect.logInfo("disposing all instances")
      yield* Effect.forEach(
        [...cache.entries()],
        (item) =>
          Effect.gen(function* () {
            const exit = yield* Deferred.await(item[1].deferred).pipe(Effect.exit)
            if (Exit.isFailure(exit)) {
              yield* Effect.logWarning("instance dispose failed").pipe(
                Effect.annotateLogs({ key: item[0], cause: exit.cause }),
              )
              yield* removeEntry(item[0], item[1])
              return
            }
            yield* disposeEntry(item[0], item[1], exit.value)
          }),
        { discard: true },
      )
    })

    const cachedDisposeAll = yield* Effect.cachedWithTTL(disposeAllOnce(), Duration.zero)
    const disposeAll = Effect.fn("InstanceStore.disposeAll")(function* () {
      return yield* cachedDisposeAll
    })

    const provide = <A, E, R>(input: LoadInput, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      load(input).pipe(Effect.flatMap((ctx) => effect.pipe(Effect.provideService(InstanceRef, ctx))))

    yield* Effect.addFinalizer(() => disposeAll().pipe(Effect.ignore))

    return Service.of({
      load,
      reload,
      dispose,
      disposeAll,
      provide,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Project.defaultLayer))

export * as InstanceStore from "./instance-store"
