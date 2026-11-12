import { randomBytes } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { Log } from "@opencode-ai/core/util/log"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Loaded } from "./manifest"
import { ExtensionRegistry } from "./registry"
import { ExtensionID, type Info, type Source } from "./schema"
import { ExtensionRuntime, ExtensionMutationError } from "./runtime"
import { publish } from "./event"
import type { ExtensionWatcher as Watcher } from "./watch"

const token = randomBytes(18).toString("base64url")

function base(manifest: Loaded) {
  return `/extension-asset/${token}/${encodeURIComponent(manifest.id)}/${encodeURIComponent(manifest.versionSegment)}/`
}

function attempt<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })
}

export type Asset = {
  id: ExtensionID
  version: string
  webRoot: string
  source: Source["type"]
}

export interface Interface {
  readonly token: string
  readonly list: () => Effect.Effect<Info[], Error>
  readonly get: (id: ExtensionID) => Effect.Effect<Info, Error>
  readonly link: (directory: string) => Effect.Effect<Info, Error>
  readonly setEnabled: (id: ExtensionID, enabled: boolean) => Effect.Effect<Info, Error>
  readonly retry: (id: ExtensionID) => Effect.Effect<Info, Error>
  readonly asset: (id: ExtensionID, version: string) => Effect.Effect<Asset | undefined, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Extension") {}

// The extension runtime and watcher are process-wide singletons shared by
// every independent Effect layer built on this module. Ownership is
// reference-counted: each enabled layer acquires a lease at build time, and
// the shutdown cleanup (dispose the runtime, stop the watcher) only runs when
// the LAST lease is released — an earlier scope exiting must not tear down
// shared state the remaining scopes still use. Layers built in pure/disabled
// mode never touch the runtime and therefore never clean up state they do
// not own.
let leases = 0

function acquireLease(watcher: Watcher) {
  leases++
  let released = false
  return async () => {
    if (released) return
    released = true
    leases--
    if (leases > 0) return
    // Last scope out performs the shutdown cleanup.
    await ExtensionRuntime.disposeAll()
    await watcher.stop()
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const disabled = () => flags.pure || flags.disableExtensions
    const watcher: Watcher | undefined = disabled()
      ? undefined
      : yield* Effect.promise(async () =>
          (await import("./watch")).ExtensionWatcher.start({
            invalidateInstances: ExtensionRuntime.invalidateHooks,
            reloadExtension: (id) => ExtensionRuntime.reload(id),
          }),
        )
    if (watcher) {
      const release = acquireLease(watcher)
      yield* Effect.addFinalizer(() => Effect.promise(() => release()))
      const stopObserving = yield* Effect.promise(async () =>
        (await import("./install-service")).observeInstallations(),
      )
      yield* Effect.addFinalizer(() => Effect.promise(stopObserving))
      // Resume cleanups that were deferred by live processes (process-pinned
      // generations, pending purges). Without this a reinstall of the same
      // extension conflicts with its retained record until a manual wipe.
      yield* Effect.promise(async () => {
        const mod = await import("./install-service")
        try {
          const report = await mod.recoverInstallations()
          if (report.cleanupPending) {
            Log.create({ service: "extension" }).info("extension cleanup still pending after recovery")
          }
        } catch (error) {
          Log.create({ service: "extension" }).error("extension cleanup recovery failed", {
            error: String(error),
          })
        }
      })
    }
    const refreshWatcher = () => watcher?.refresh().catch(() => undefined)
    const list = () =>
      disabled()
        ? Effect.succeed([])
        : attempt(async () => {
            const items = await ExtensionRegistry.list(base)
            return items.map((item) => ({
              ...item,
              server: ExtensionRuntime.describe(item.id),
            }))
          })
    const get = (id: ExtensionID) =>
      disabled()
        ? Effect.fail(new Error(`Extensions are disabled: ${id}`))
        : attempt(async () => {
            const item = await ExtensionRegistry.get(id, base)
            return { ...item, server: ExtensionRuntime.describe(id) }
          })
    const link = (directory: string) =>
      disabled()
        ? Effect.fail(new Error("Extensions are disabled"))
        : attempt(async () => {
            const info = await ExtensionRegistry.link(directory, base)
            await refreshWatcher()
            return info
          })
    const setEnabled = (id: ExtensionID, enabled: boolean) =>
      disabled()
        ? Effect.fail(new Error(`Extensions are disabled: ${id}`))
        : attempt(async () => {
            const info = await ExtensionRegistry.setEnabled(id, enabled, base)
            await ExtensionRuntime.invalidateHooks()
            if (!enabled) await ExtensionRuntime.disable(id)
            await refreshWatcher()
            return info
          })
    const retry = (id: ExtensionID) =>
      disabled()
        ? Effect.fail(new Error(`Extensions are disabled: ${id}`))
        : attempt(async () => {
            const item = await ExtensionRegistry.get(id, base)
            if (!item.enabled) throw new ExtensionMutationError(id)
            await ExtensionRuntime.retry(id)
            publish({ id, version: item.version, state: "changed" })
            return { ...(await ExtensionRegistry.get(id, base)), server: ExtensionRuntime.describe(id) }
          })
    const asset = (id: ExtensionID, version: string) =>
      disabled()
        ? Effect.succeed(undefined)
        : attempt(async () => {
            const linked = await ExtensionRegistry.linked(id)
            if (!linked?.row.enabled || !linked.manifest.entry) return
            if (linked.manifest.versionSegment !== version) return
            return {
              id,
              version,
              webRoot: linked.manifest.webRoot,
              source: linked.row.source.type,
            }
          })

    return Service.of({ token, list, get, link, setEnabled, retry, asset })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(RuntimeFlags.defaultLayer))

export function assetToken() {
  return token
}

export function extensionID(input: string) {
  return ExtensionID.make(input)
}

export * as Extension from "."
