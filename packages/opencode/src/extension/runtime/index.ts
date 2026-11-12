import path from "node:path"
import * as Log from "@opencode-ai/core/util/log"
import { Global } from "@opencode-ai/core/global"
import type { PluginInput } from "@opencode-ai/plugin"
import type {
  ExtensionHooks,
  ExtensionHost,
  ExtensionService,
  RpcHandler,
  ServerExtension,
} from "@opencode-ai/extension-kit/server"
import { GlobalBus } from "@/bus/global"
import { ExtensionRegistry, NotFoundError, registryFile } from "../registry"
import { ExtensionLeases } from "../leases"
import { provisionData } from "../data"
import { assertDevelopmentDirectory, ownedGeneration } from "../paths"
import { publishError, publish as publishStatus } from "../event"
import { ExtensionID, type Info, type RegistryRow, type ServerInfo } from "../schema"
import type { Loaded } from "../manifest"
import { defaultImporter, type Importer } from "./module-cache"
import { SlotStore, emptyEntry, type Entry } from "./slot"
import { createHookOwner } from "./hooks"
import { makeTimerScope } from "./timers"

const log = Log.create({ service: "extension" })

/**
 * Raised by {@link ExtensionRuntime.rpc} when the RPC call cannot be routed to
 * a handler: the extension is not enabled, has no server entry, failed to
 * activate, or does not know the method. Messages intentionally only carry the
 * extension id and method so they are safe to return to HTTP clients.
 */
export class ExtensionRpcNotFoundError extends Error {
  override readonly name = "ExtensionRpcNotFoundError"

  constructor(
    readonly id: string,
    readonly method: string,
  ) {
    super(`Unknown extension RPC method: ${id}.${method}`)
  }
}

/**
 * Raised when an extension RPC handler reports a domain error. Extensions
 * throw the duck-typed `{ name: "ExtensionRpcError", code, message }` shape
 * from the extension-kit contract; the runtime normalizes it to this class so
 * the HTTP layer can map it to a 400 response with the original code.
 */
export class ExtensionRpcError extends Error {
  override readonly name = "ExtensionRpcError"

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Raised by {@link ExtensionRuntime.rpc} when the call's signal was already
 * aborted (or aborts while the runtime is still preparing the handler). The
 * handler is never invoked in that case. `name` is "AbortError" so generic
 * abort handling upstream recognizes it.
 */
export class ExtensionRpcAbortedError extends Error {
  override readonly name = "AbortError"

  constructor(
    readonly id: string,
    readonly method: string,
  ) {
    super(`Extension RPC aborted: ${id}.${method}`)
  }
}

/** Installation cannot run concurrently with runtime work or another mutation. */
export class ExtensionMutationError extends Error {
  override readonly name = "ExtensionMutationError"

  constructor(
    readonly id: string,
    readonly needsRestart = false,
  ) {
    super(needsRestart ? `Extension requires restart: ${id}` : `Extension mutation in progress: ${id}`)
  }
}

/**
 * Instance-level hooks contributed by an enabled extension. `id` is used by
 * Plugin.state as the `extension:<id>` hook entry id.
 */
export type InstanceHookEntry = {
  id: string
  hooks: ExtensionHooks
}

/** Request shape shared with the HTTP RPC adapter. */
export type ExtensionRpcCall = {
  id: string
  method: string
  input?: unknown
  directory?: string
  signal?: AbortSignal
}

let importer: Importer = defaultImporter

type Lease = Awaited<ReturnType<typeof ExtensionLeases.acquire>>
type LeaseDriver = Pick<typeof ExtensionLeases, "acquire" | "acquireData">
let leaseDriver: LeaseDriver = ExtensionLeases
// Imported code can retain unmanaged timers/raw closures after dispose. Pin
// every imported managed generation until process exit, not merely strict stop.
const generationPins = new Map<string, Lease>()
const dataPins = new Map<string, Lease>()
const retainedTestPins = new Set<Lease>()

function pinKey(registry: string, identity: string) {
  return JSON.stringify([registry, identity])
}

async function acquirePin(
  pins: Map<string, Lease>,
  key: string,
  acquire: () => Promise<Lease>,
  available: () => boolean,
) {
  if (pins.has(key)) return available()
  const lease = await acquire()
  if (!available() || pins.has(key)) {
    // No code has used this handle; an existing pin, if any, stays owned.
    try {
      await lease.release()
    } catch (error) {
      // Unconfirmed release is conservatively retained for process lifetime.
      if (!pins.has(key)) pins.set(key, lease)
      throw error
    }
    return available()
  }
  pins.set(key, lease)
  return true
}

const DISPOSE_TIMEOUT_MS = 10_000
const ACTIVATE_TIMEOUT_MS = 10_000
const SERVER_TIMEOUT_MS = 10_000
let activateTimeoutMs = ACTIVATE_TIMEOUT_MS
let serverTimeoutMs = SERVER_TIMEOUT_MS

class ExtensionPhaseTimeoutError extends Error {
  constructor(phase: "activation" | "server", timeoutMs: number) {
    super(`${phase} timed out after ${timeoutMs}ms`)
  }
}

async function phaseDeadline<T>(task: Promise<T>, phase: "activation" | "server", timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExtensionPhaseTimeoutError(phase, timeoutMs)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function withTimeout(promise: Promise<unknown>, timeoutMs: number | undefined) {
  const limit = timeoutMs ?? DISPOSE_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limit)
    timer.unref?.()
  })
  try {
    await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function disposeService(id: string, service: ExtensionService | undefined, timeoutMs?: number) {
  if (!service?.dispose) return
  let disposal = serviceDisposals.get(service)
  if (!disposal) {
    disposal = track(
      id,
      Promise.resolve()
        .then(() => service.dispose!())
        .then(
          () => true,
          (error) => {
            recordDisposalFailure(id, error)
            log.error("extension dispose failed", { extension: id, error })
            return false
          },
        ),
    )
    serviceDisposals.set(service, disposal)
  }
  await withTimeout(disposal, timeoutMs)
}

function duckTypedRpcError(error: unknown) {
  if (!error || typeof error !== "object") return
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown }
  if (candidate.name !== "ExtensionRpcError") return
  if (typeof candidate.code !== "string") return
  return new ExtensionRpcError(candidate.code, typeof candidate.message === "string" ? candidate.message : "")
}

function dataDir(id: string) {
  return path.join(Global.Path.data, "extensions", "data", id)
}

/**
 * Effective settings handed to the extension: stored registry values with
 * manifest defaults filled in for declared keys that have no stored value.
 * Mirrors the registry's user-facing view without secret masking — the
 * extension is entitled to its own secret values.
 */
function resolveSettings(manifest: Loaded, stored: Record<string, unknown> | undefined) {
  const resolved: Record<string, unknown> = { ...(stored ?? {}) }
  for (const [key, definition] of Object.entries(manifest.contributes.settings ?? {})) {
    if (key in resolved || definition.default === undefined) continue
    resolved[key] = definition.default
  }
  return resolved
}

/**
 * Re-reads the registry settings for an extension so a row snapshot taken
 * before a concurrent settings update (or `notifySettings`) cannot clobber
 * newer values. Falls back to the caller's row when the registry is
 * unreadable or the extension was unlinked in the meantime.
 */
async function currentSettings(
  id: ExtensionID,
  fallback: RegistryRow,
  registry = registryFile(),
): Promise<Record<string, unknown> | undefined> {
  const linked = await ExtensionRegistry.linked(id, registry).catch(() => undefined)
  return (linked?.row ?? fallback).settings
}

function cacheDir(id: string) {
  return path.join(Global.Path.cache, "extensions", id)
}

function disposeResources(entry: Entry | undefined) {
  if (!entry) return
  for (const dispose of [...entry.resources]) dispose()
}

function createHost(entry: Entry, manifest: Loaded, serverUrl: URL | undefined) {
  if (serverUrl) entry.serverUrl = serverUrl
  const id = manifest.id
  const gen = generationOf(id)
  const epoch = slots.get(id).epoch
  const started = Date.now()
  let closed = false
  const timers = makeTimerScope({
    available: () => !closed && !gated(id) && generationOf(id) === gen && slots.get(id).entry === entry,
    track: (promise) => track(id, promise),
    onError(error) {
      if (closed || generationOf(id) !== gen || slots.get(id).entry !== entry) return
      slots.transition(id, {
        type: "runtime.error",
        phase: "timer",
        error: error instanceof Error ? error.message : String(error),
      })
      log.error("extension timer failed", {
        extension: id,
        phase: "timer",
        gen,
        epoch,
        elapsedMs: Date.now() - started,
        error,
      })
      publishError(manifest.id, manifest.version, error)
    },
  })
  const dispose = () => {
    if (closed) return
    closed = true
    timers.dispose()
    entry.resources.delete(dispose)
  }
  entry.resources.add(dispose)
  const host: ExtensionHost = {
    id,
    version: manifest.version,
    dataDir: dataDir(id),
    cacheDir: cacheDir(id),
    serverUrl: entry.serverUrl ?? new URL("http://127.0.0.1"),
    settings: {
      get() {
        return { ...entry.settings }
      },
      onDidChange(listener) {
        entry.settingsListeners.add(listener)
        return () => entry.settingsListeners.delete(listener)
      },
    },
    setTimeout: timers.setTimeout,
    setInterval: timers.setInterval,
    emit(name, data, options) {
      GlobalBus.emit("event", {
        directory: options?.directory ?? "global",
        payload: {
          type: "extension.event",
          properties: { id, name, data },
        },
      })
    },
    log: {
      debug(message, extra) {
        log.debug(message, { extension: id, ...extra })
      },
      info(message, extra) {
        log.info(message, { extension: id, ...extra })
      },
      warn(message, extra) {
        log.warn(message, { extension: id, ...extra })
      },
      error(message, extra) {
        log.error(message, { extension: id, ...extra })
      },
    },
  }
  return { host, dispose }
}

type CacheKind = "tool" | "plugin"
const cacheInvalidators: Record<CacheKind, Set<() => Promise<void>>> = {
  tool: new Set(),
  plugin: new Set(),
}

function registerCacheInvalidator(kind: CacheKind, invalidateCache: () => Promise<void>) {
  cacheInvalidators[kind].add(invalidateCache)
  return () => cacheInvalidators[kind].delete(invalidateCache)
}

let invalidatingHooks: Promise<void> | undefined
let hooksInvalidationRevision = 0

function invalidateHooks(): Promise<void> {
  // Every request, including one arriving after the Plugin phase, needs a
  // complete round that starts after its snapshot. Concurrent requests share
  // the drain, not an already-obsolete round.
  hooksInvalidationRevision++
  if (invalidatingHooks) return invalidatingHooks
  const invalidation = Promise.resolve().then(async () => {
    try {
      let covered: number
      do {
        covered = hooksInvalidationRevision
        // This round covers released dirty ids only. A still-held fence retains
        // its fallback, and a later release will advance the revision again.
        for (const id of staleHookIds) {
          const slot = slots.get(id)
          if (!slot.fenced && !slot.quiescing) staleHookIds.delete(id)
        }
        if (!staleHookIds.size) {
          clearTimeout(staleHooksTimer)
          staleHooksTimer = undefined
        }
        // Preserve teardown ordering, then remove Tool values rebuilt from the
        // old Plugin snapshot between the first two phases.
        for (const kind of ["tool", "plugin", "tool"] as const) {
          await Promise.all([...cacheInvalidators[kind]].map((invalidateCache) => invalidateCache()))
        }
      } while (covered !== hooksInvalidationRevision)
    } finally {
      // Clear ownership in the same continuation as the final revision check;
      // a separate Promise.finally leaves a window that can swallow a request.
      if (invalidatingHooks === invalidation) invalidatingHooks = undefined
    }
  })
  invalidatingHooks = invalidation
  return invalidation
}

const slots = new SlotStore()
// A skipped transient mutation must expire the enclosing instance cache after
// release, never repeatedly rebuild it while the same fence is still held.
const staleHookIds = new Set<string>()
let staleHooksTimer: ReturnType<typeof setTimeout> | undefined

function scheduleStaleHooks() {
  if (staleHooksTimer || ![...staleHookIds].some((id) => !slots.get(id).fenced && !slots.get(id).quiescing)) return
  // A task turn (not an immediate microtask) lets the caller finish publishing
  // its cache value before invalidation, including Promise/Effect adapters.
  staleHooksTimer = setTimeout(() => {
    staleHooksTimer = undefined
    let changed = false
    for (const id of staleHookIds) {
      if (slots.get(id).fenced || slots.get(id).quiescing) continue
      staleHookIds.delete(id)
      changed = true
    }
    if (changed)
      void invalidateHooks().catch((error) => log.error("extension stale hooks invalidation failed", { error }))
  }, 0)
  staleHooksTimer.unref?.()
}

function recordDisposalFailure(id: string, error: unknown) {
  slots.transition(id, { type: "disposal.failed", error: error instanceof Error ? error.message : String(error) })
}

function markBlocked(id: string, error?: unknown, elapsedMs = 0) {
  const first = !slots.get(id).blocked
  slots.transition(id, {
    type: "blocked",
    error:
      error instanceof Error ? error.message : String(error ?? "Extension cleanup did not complete; restart required"),
  })
  log.error("extension runtime blocked", {
    extension: id,
    phase: "quiesce",
    gen: generationOf(id),
    epoch: slots.get(id).epoch ?? 0,
    elapsedMs,
    error: slots.get(id).error,
  })
  if (first) {
    publishStatus({
      id: ExtensionID.make(id),
      version: slots.get(id).version ?? "unknown",
      state: "blocked",
      error: slots.get(id).error,
    })
  }
}
let serviceDisposals = new WeakMap<ExtensionService, Promise<boolean>>()
const hookOwner = createHookOwner({
  slots,
  assertAvailable,
  mutationError: (id) => new ExtensionMutationError(id, slots.get(id).blocked),
  recordDisposalFailure,
  withTimeout,
  disposeTimeoutMs: DISPOSE_TIMEOUT_MS,
})
const { finalizeHooks, disposeHooks, bindHooks } = hookOwner

function gated(id: string) {
  return slots.gated(id)
}

function assertAvailable(id: string) {
  if (gated(id)) throw new ExtensionMutationError(id, slots.get(id).blocked)
}

function beginMutation(id: string): () => void {
  assertAvailable(id)
  // The transition advances generation and epoch before any caller can await.
  slots.transition(id, { type: "mutation.begin" })
  let released = false
  return () => {
    if (released) return
    released = true
    slots.transition(id, { type: "mutation.release" })
    // A first install may not have appeared in a registry snapshot at all.
    // Always expire values built under its fence, even without a skipped row.
    staleHookIds.add(id)
    scheduleStaleHooks()
  }
}

function track<T>(id: string, promise: Promise<T>): Promise<T> {
  return slots.track(id, promise)
}

/** Strict installation teardown; unlike disable/reload, uncertainty is sticky. */
async function quiesce(
  id: string,
  options: { timeoutMs?: number } = {},
): Promise<{
  stopped: boolean
  needsRestart: boolean
}> {
  if (slots.get(id).quiescing) throw new ExtensionMutationError(id, slots.get(id).blocked)
  const started = Date.now()
  slots.transition(id, { type: "quiesce.begin" })
  const entry = slots.get(id).entry
  disposeResources(entry)
  slots.transition(id, { type: "entry.drop" })
  slots.transition(id, { type: "load.drop" })
  entry?.settingsListeners.clear()
  for (const request of slots.get(id).requests ?? []) request.abort(new Error(`Extension mutation: ${id}`))
  // Existing instance finalizers belong to Plugin/Instance invalidation. Do
  // not invoke them a second time; their completion is observed below.
  const stopped = (async () => {
    await disposeService(id, entry?.service, options.timeoutMs)
    // Tasks can create late disposal tasks while settling, so drain to idle,
    // rather than waiting on only the first snapshot.
    while (slots.get(id).pending?.size) await Promise.allSettled([...slots.get(id).pending!])
  })()
  let complete = false
  try {
    await withTimeout(
      stopped.then(() => {
        complete = true
      }),
      options.timeoutMs,
    )
    if (!complete || slots.get(id).failedDisposal || slots.get(id).hooks?.size)
      markBlocked(id, undefined, Date.now() - started)
    return { stopped: complete && !slots.get(id).blocked, needsRestart: slots.get(id).blocked }
  } catch (error) {
    log.error("extension quiesce failed", { extension: id, error })
    markBlocked(id, error, Date.now() - started)
    return { stopped: false, needsRestart: true }
  } finally {
    slots.transition(id, { type: "quiesce.end" })
    scheduleStaleHooks()
  }
}

/**
 * Monotonic per-extension epoch. `disable` and `reload` bump it so work that
 * started earlier (module import, activation) cannot re-insert a stale entry
 * or leave a freshly activated service behind after the teardown happened.
 */
function generationOf(id: string) {
  return slots.get(id).generation
}

function invalidate(id: string) {
  slots.transition(id, { type: "invalidate" })
}

function sourceOf(manifest: Loaded) {
  if (!manifest.serverEntry) return
  return path.resolve(manifest.dir, manifest.serverEntry)
}

async function importEntry(manifest: Loaded, source: string): Promise<Entry> {
  const entry = emptyEntry(manifest.id, {})
  entry.manifest = manifest
  entry.fingerprint = manifest.serverFingerprint
  entry.source = source
  try {
    const module = await importer(source, manifest.serverFingerprint, { id: manifest.id, dir: manifest.dir })
    if (!module || typeof module !== "object")
      throw new Error(`Extension server entry has no default export: ${manifest.id}`)
    if (module.id && module.id !== manifest.id)
      throw new Error(`Extension server entry id mismatch: expected ${manifest.id}, got ${module.id}`)
    entry.module = module
  } catch (error) {
    slots.transition(manifest.id, {
      type: "entry.error",
      entry,
      phase: "import",
      error: error instanceof Error ? error.message : String(error),
    })
    log.error("extension server entry failed to import", { extension: manifest.id, error })
    publishError(manifest.id, manifest.version, error)
  }
  return entry
}

/**
 * Returns the process-level entry for an extension, importing the server
 * module when needed. Import/activate failures are sticky: the entry stays in
 * the error state until {@link reload}, {@link notifySettings} or a server
 * fingerprint change clears it. Returns undefined when the entry was disabled
 * or replaced while the import was in flight.
 */
async function ensureEntry(
  manifest: Loaded,
  row: RegistryRow,
  serverUrl: URL | undefined,
  registry: string,
): Promise<Entry | undefined> {
  const id = manifest.id
  slots.get(id).version = manifest.version
  let gen = generationOf(id)
  const epoch = slots.get(id).epoch ?? 0
  if (gated(id)) return
  const source = sourceOf(manifest)
  if (!source) return

  const existing = slots.get(id).entry
  if (existing) {
    const changed = existing.fingerprint !== manifest.serverFingerprint || existing.source !== source
    if (changed) {
      await reload(id)
      if (gated(id) || (slots.get(id).epoch ?? 0) !== epoch) return
      gen = generationOf(id)
    } else if (existing.status === "error") {
      return
    } else if (existing.module) {
      // Re-read the registry so a row snapshot taken before a concurrent
      // settings update cannot clobber the newer values it holds.
      const stored = await currentSettings(id, row, registry)
      // The entry can be disabled or reloaded while the settings were read.
      if (gated(id) || generationOf(id) !== gen || slots.get(id).entry !== existing) return
      existing.settings = resolveSettings(manifest, stored)
      if (serverUrl) existing.serverUrl = serverUrl
      return existing
    }
  }

  const inflight = slots.get(id).loading
  if (inflight) {
    const entry = await inflight
    if (gated(id) || generationOf(id) !== gen || slots.get(id).entry !== entry) return
    return entry
  }

  const load = track(
    id,
    Promise.resolve().then(async () => {
      // Acquisition itself is tracked and deduplicated before the first await;
      // quiesce cannot report idle while a lease/import is arriving late.
      const available = () => !gated(id) && generationOf(id) === gen
      if (!available()) return
      if (row.source.type === "path") await assertDevelopmentDirectory(manifest.dir)
      if (!(await acquirePin(dataPins, pinKey(registry, id), () => leaseDriver.acquireData(registry, id), available)))
        return
      if (row.source.type !== "path" && row.installId) {
        if (
          !(await acquirePin(
            generationPins,
            pinKey(registry, row.installId),
            () => leaseDriver.acquire(registry, row.installId!),
            available,
          ))
        )
          return
        // acquire may precede installer materialization. Revalidate ownership
        // and registry identity only after the collector can no longer remove it.
        await ownedGeneration(registry, row)
        const current = await ExtensionRegistry.linked(manifest.id, registry)
        if (
          !current?.row.enabled ||
          current.row.installId !== row.installId ||
          current.row.dir !== row.dir ||
          current.manifest.serverFingerprint !== manifest.serverFingerprint
        )
          return
      }
      if (!available()) return
      await provisionData({ id, name: row.name, source: row.source, dataSource: row.dataSource })
      if (!available()) return
      const entry = await importEntry(manifest, source)
      // Re-read so a settings update landing during the import is not lost.
      const stored = await currentSettings(id, row, registry)
      entry.settings = resolveSettings(manifest, stored)
      if (serverUrl) entry.serverUrl = serverUrl
      // A disable/reload during the import must not resurrect the entry.
      if (!gated(id) && generationOf(id) === gen) slots.transition(id, { type: "entry.set", entry })
      return entry
    }),
  )
  slots.transition(id, { type: "load.set", loading: load })
  try {
    const entry = await load
    if (gated(id) || generationOf(id) !== gen || slots.get(id).entry !== entry) return
    return entry
  } finally {
    if (slots.get(id).loading === load) slots.transition(id, { type: "load.drop" })
  }
}

/**
 * Activates the process-level service for an entry, deduplicating concurrent
 * activations so every caller observes the same service instance. If the
 * extension is disabled or reloaded while activation is in flight, the fresh
 * service is disposed immediately instead of being cached on a stale entry.
 */
async function ensureService(entry: Entry, manifest: Loaded, serverUrl: URL | undefined) {
  const id = entry.id
  const gen = generationOf(id)
  if (gated(id) || slots.get(id).entry !== entry) return
  if (entry.status === "ready") return entry.service
  if (entry.status === "error") return
  if (entry.activating) return entry.activating

  const started = Date.now()
  const epoch = slots.get(id).epoch ?? 0
  const detail = () => ({ extension: id, phase: "activate", gen, epoch, elapsedMs: Date.now() - started })
  log.debug("extension activate start", detail())
  // Track the original work, not the deadline: strict stop must still observe
  // a hung activation and any disposal it creates after callers have returned.
  const host = createHost(entry, manifest, serverUrl)
  const activation = track(
    id,
    Promise.resolve().then(async () => {
      const service = ((await entry.module?.activate?.(host.host)) ?? {}) as ExtensionService
      if (gated(id) || generationOf(id) !== gen || slots.get(id).entry !== entry) {
        host.dispose()
        await disposeService(id, service, 0)
        log.debug("extension late activation disposed", detail())
        return undefined
      }
      slots.transition(id, { type: "activate.ready", entry, service })
      log.debug("extension activate ok", detail())
      return service
    }),
  )

  // Every concurrent caller joins this same bounded, normalized result. Joining
  // the raw activation would bypass its timeout and leak rejections to peers.
  const bounded = phaseDeadline(activation, "activation", activateTimeoutMs)
    .catch((error) => {
      host.dispose()
      log.error(
        error instanceof ExtensionPhaseTimeoutError ? "extension activate timeout" : "extension activate failed",
        {
          ...detail(),
          error,
        },
      )
      if (!gated(id) && generationOf(id) === gen && slots.get(id).entry === entry) {
        slots.transition(id, {
          type: "entry.error",
          entry,
          phase: error instanceof ExtensionPhaseTimeoutError ? "timeout" : "activate",
          error: error instanceof Error ? error.message : String(error),
        })
        // Leave the error entry sticky, but make a late service generation-stale.
        if (error instanceof ExtensionPhaseTimeoutError) invalidate(id)
        publishError(manifest.id, manifest.version, error)
      }
      return undefined
    })
    .finally(() => {
      if (entry.activating === bounded) entry.activating = undefined
    })
  entry.activating = bounded
  return bounded
}

function callServer(entry: Entry, manifest: Loaded, input: PluginInput) {
  return callServerInternal(entry, manifest, input)
}

async function callServerInternal(entry: Entry, manifest: Loaded, input: PluginInput) {
  if (gated(entry.id) || slots.get(entry.id).entry !== entry) return
  const server = entry.module?.server
  if (!server) return
  const id = entry.id
  const gen = generationOf(id)
  const epoch = slots.get(id).epoch ?? 0
  const started = Date.now()
  const detail = () => ({ extension: id, phase: "server", gen, epoch, elapsedMs: Date.now() - started })
  const host = createHost(entry, manifest, input.serverUrl)
  const extensionInput = { ...input, extension: Object.assign(host.host, { service: entry.service }) }
  // A deadline belongs to this instance call, not the process generation. One
  // directory timing out must not invalidate another directory's healthy hooks.
  let expired = false
  log.debug("extension server start", detail())
  const task = track(
    id,
    Promise.resolve().then(async () => {
      const hooks = ((await server(extensionInput)) ?? {}) as ExtensionHooks
      if (expired || gated(id) || generationOf(id) !== gen || slots.get(id).entry !== entry) {
        host.dispose()
        await disposeHooks(id, hooks)
        log.debug("extension late server hooks disposed", detail())
        return
      }
      const directory = input.directory
      bindHooks(id, gen, hooks)
      const original = hooks.dispose
      const finalize = () => {
        host.dispose()
        return original?.call(hooks)
      }
      hookOwner.setFinalizer(hooks, finalize)
      // The instance owns the finalizer; keep runtime tracking in sync without
      // disposing externally owned hooks a second time during process stop.
      hooks.dispose = async () => {
        if (entry.instances.get(directory) === hooks) entry.instances.delete(directory)
        host.dispose()
        await finalizeHooks(id, hooks, finalize)
      }
      slots.get(id).hooks.add(hooks)
      entry.instances.set(directory, hooks)
      slots.transition(id, { type: "server.ready" })
      log.debug("extension server ok", detail())
      return hooks
    }),
  )
  try {
    return await phaseDeadline(task, "server", serverTimeoutMs)
  } catch (error) {
    expired = true
    host.dispose()
    if (!gated(id) && generationOf(id) === gen && slots.get(id).entry === entry) {
      slots.transition(id, {
        type: "runtime.error",
        phase: "server",
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (!(error instanceof ExtensionPhaseTimeoutError)) {
      log.error("extension server failed", { ...detail(), error })
      throw error
    }
    log.warn("extension server timeout", { ...detail(), error })
    publishError(manifest.id, manifest.version, error)
  }
}

async function instanceHooks(input: PluginInput, options: { disabled?: boolean } = {}): Promise<InstanceHookEntry[]> {
  if (options.disabled) return []
  const registry = registryFile()
  const epochs = slots.epochs()
  let list: Info[]
  try {
    list = await ExtensionRegistry.list(() => "", registry)
  } catch (error) {
    // A corrupt registry file must not break Plugin.state for every instance.
    log.error("extension registry list failed", { error })
    return []
  }
  const eligible = list.filter((info) => info.enabled && info.state === "ready")
  const stale = new Set<string>()
  const changed = (id: string) => gated(id) || (slots.get(id).epoch ?? 0) !== (epochs.get(id) ?? 0)
  const available = (id: string) => {
    if (changed(id)) throw new ExtensionMutationError(id, slots.get(id).blocked)
  }
  // Start every extension independently; allSettled preserves registry order
  // and a failed lease/mutation cannot discard a healthy peer's hooks.
  const settled = await Promise.allSettled(
    eligible.map(async (info): Promise<InstanceHookEntry | undefined> => {
      const started = Date.now()
      const gen = generationOf(info.id)
      let hooks: ExtensionHooks | undefined
      try {
        available(info.id)
        const linked = await ExtensionRegistry.linked(info.id, registry)
        available(info.id)
        if (!linked) return
        const { row, manifest } = linked
        if (!row.enabled || !manifest.serverEntry) return
        const entry = await ensureEntry(manifest, row, input.serverUrl, registry)
        available(info.id)
        if (!entry?.module) return
        const service = await ensureService(entry, manifest, input.serverUrl)
        available(info.id)
        if (!service || slots.get(manifest.id).entry !== entry) return
        hooks = await callServer(entry, manifest, input)
        available(info.id)
        if (hooks && slots.get(manifest.id).entry !== entry) {
          await disposeHooks(manifest.id, hooks)
          return
        }
        if (hooks) return { id: manifest.id, hooks }
      } catch (error) {
        if (hooks) await disposeHooks(info.id, hooks)
        const detail = {
          extension: info.id,
          phase: "instanceHooks",
          gen,
          epoch: epochs.get(info.id) ?? 0,
          elapsedMs: Date.now() - started,
          error,
        }
        if (error instanceof ExtensionMutationError) {
          if (!error.needsRestart) stale.add(info.id)
          log.warn("extension instance hooks skipped mutation", detail)
        } else if (error instanceof ExtensionLeases.LeaseError) {
          log.warn("extension instance hooks skipped lease", detail)
        } else {
          log.error("extension instance hooks failed", detail)
        }
      }
    }),
  )
  const result: InstanceHookEntry[] = []
  for (let index = 0; index < eligible.length; index++) {
    const info = eligible[index]!
    const outcome = settled[index]!
    const entry = outcome.status === "fulfilled" ? outcome.value : undefined
    if (changed(info.id)) {
      if (!slots.get(info.id).blocked) stale.add(info.id)
      if (entry) await disposeHooks(info.id, entry.hooks)
    } else if (entry) {
      result.push(entry)
    }
    if (outcome.status === "rejected") {
      log.error("extension instance hooks collection failed", {
        extension: info.id,
        phase: "instanceHooks",
        error: outcome.reason,
      })
    }
  }
  for (const id of stale) staleHookIds.add(id)
  scheduleStaleHooks()
  return result
}

async function rpc(call: ExtensionRpcCall): Promise<unknown> {
  const signal = call.signal
  const aborted = () => new ExtensionRpcAbortedError(call.id, call.method)
  if (signal?.aborted) throw aborted()

  const id = ExtensionID.make(call.id)
  const registry = registryFile()
  const epoch = slots.get(id).epoch ?? 0
  const available = () => {
    assertAvailable(id)
    if ((slots.get(id).epoch ?? 0) !== epoch) throw new ExtensionMutationError(id, slots.get(id).blocked)
  }
  available()
  const linked = await ExtensionRegistry.linked(id, registry)
  available()
  if (signal?.aborted) throw aborted()
  if (!linked) throw new NotFoundError(id)
  const { row, manifest } = linked
  if (!row.enabled || !manifest.serverEntry) throw new ExtensionRpcNotFoundError(call.id, call.method)

  const entry = await ensureEntry(manifest, row, undefined, registry)
  available()
  if (signal?.aborted) throw aborted()
  // The entry can be replaced or removed while the import was in flight.
  if (!entry?.module || slots.get(manifest.id).entry !== entry)
    throw new ExtensionRpcNotFoundError(call.id, call.method)
  const service = await ensureService(entry, manifest, undefined)
  available()
  if (signal?.aborted) throw aborted()
  if (!service || slots.get(manifest.id).entry !== entry) throw new ExtensionRpcNotFoundError(call.id, call.method)

  const instanceHandler = call.directory ? entry.instances.get(call.directory)?.rpc?.[call.method] : undefined
  const handler: RpcHandler | undefined = instanceHandler ?? service.rpc?.[call.method]
  if (!handler) throw new ExtensionRpcNotFoundError(call.id, call.method)

  available()
  const request = new AbortController()
  const cancel = () => request.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener("abort", cancel, { once: true })
  entry.requests.add(request)
  let requests = slots.get(id).requests

  requests.add(request)
  if (request.signal.aborted) {
    entry.requests.delete(request)
    requests.delete(request)
    signal?.removeEventListener("abort", cancel)
    throw aborted()
  }
  try {
    const result = await track(
      id,
      Promise.resolve().then(() => {
        available()
        if (request.signal.aborted) throw aborted()
        return handler(call.input, { directory: call.directory, signal: request.signal })
      }),
    )
    available()
    return result
  } catch (error) {
    const normalized = duckTypedRpcError(error)
    if (normalized) throw normalized
    throw error
  } finally {
    entry.requests.delete(request)
    requests.delete(request)

    signal?.removeEventListener("abort", cancel)
  }
}

async function disable(id: string, options: { timeoutMs?: number } = {}) {
  invalidate(id)
  // A still-pending import from the previous generation must not be joined by
  // fresh callers: drop it so the next request starts its own load. The stale
  // load's cleanup is identity-guarded, so removing the entry here cannot
  // delete a newer load registered later.
  slots.transition(id, { type: "load.drop" })
  const entry = slots.get(id).entry
  if (!entry) return
  disposeResources(entry)
  slots.transition(id, { type: "entry.drop" })
  for (const request of entry.requests) request.abort(new Error(`Extension disabled: ${id}`))
  entry.requests.clear()
  entry.settingsListeners.clear()
  entry.instances.clear()
  await disposeService(id, entry.service, options.timeoutMs)
}

/**
 * Drops the cached module and service so the next use re-imports the server
 * entry. The default importer copies the module to a fresh fingerprint-scoped
 * path, making the replacement observable through a testable interface.
 */
async function reload(id: string, options: { timeoutMs?: number } = {}) {
  invalidate(id)
  // Same as disable: fresh callers must not join an abandoned in-flight import.
  slots.transition(id, { type: "load.drop" })
  const entry = slots.get(id).entry
  disposeResources(entry)
  slots.transition(id, { type: "entry.drop" })
  for (const request of entry?.requests ?? []) request.abort(new Error(`Extension reloaded: ${id}`))
  entry?.requests.clear()
  entry?.settingsListeners.clear()
  entry?.instances.clear()
  await disposeService(id, entry?.service, options.timeoutMs)
}

/**
 * Propagates a registry settings update to an activated extension. Also clears
 * a sticky error state so the extension is retried after its settings change.
 */
async function notifySettings(id: string, next: Record<string, unknown>) {
  const entry = slots.get(id).entry
  if (!entry) return
  // Manifest defaults stay resolved so a notify update cannot undo them. The
  // same resolved snapshot is stored and broadcast so listeners never observe
  // a different view than host.settings.get().
  const resolved = entry.manifest ? resolveSettings(entry.manifest, next) : { ...next }
  entry.settings = resolved
  if (entry.status === "error") {
    await disable(id)
    return
  }
  const listeners = [...entry.settingsListeners]
  for (const listener of listeners) {
    try {
      listener({ ...resolved })
    } catch (error) {
      log.error("extension settings listener failed", { extension: id, error })
    }
  }
}

/**
 * Disposes every activated process-level service. Used on server exit and by
 * tests to guarantee no state survives between cases.
 */
async function disposeAll(options: { timeoutMs?: number } = {}) {
  const ids = [...slots.values()].filter((slot) => slot.entry).map((slot) => slot.id)
  await Promise.all(ids.map((id) => disable(id, options)))
}

/**
 * Records a tool-name conflict detected while merging extension tools into the
 * ToolRegistry (D1). The caller skips the offending tool; this marks the
 * extension runtime as errored (surfaced through describe/Info.server) and
 * publishes a status event once per distinct conflict message.
 */
function markToolConflict(id: string, error: string) {
  const slot = slots.get(id)
  if (slot.transientError?.phase === "tool" && slot.transientError.message === error) return
  slots.transition(id, { type: "runtime.error", phase: "tool", error })
  log.error("extension tool name conflict", {
    extension: id,
    phase: "tool",
    gen: slot.generation,
    epoch: slot.epoch ?? 0,
    error,
  })
  publishError(ExtensionID.make(id), slot.version ?? "unknown", error)
}

function describe(id: string): ServerInfo {
  const slot = slots.get(id)
  const entry = slot.entry
  const needsRestart = slot.blocked
  const error = slot.error ?? entry?.error ?? slot.transientError?.message
  return {
    hasService: entry?.status === "ready",
    hasInstanceHooks: typeof entry?.module?.server === "function",
    runtime: needsRestart
      ? "blocked"
      : slot.transientError
        ? "error"
        : (entry?.status ?? (slot.loading ? "loading" : "idle")),
    ...(error === undefined ? {} : { error }),
    needsRestart,
  }
}

function retry(id: string): Promise<void> {
  // Deliberately synchronous: callers cannot clear a blocked/fenced runtime by
  // scheduling a reload and racing the installation fence.
  assertAvailable(id)
  return reload(id).then(() => invalidateHooks())
}

export const ExtensionRuntime = {
  instanceHooks,
  rpc,
  beginMutation,
  quiesce,
  disable,
  reload,
  notifySettings,
  disposeAll,
  describe,
  markToolConflict,
  retry,
  invalidateHooks,
  registerCacheInvalidator,
  testing: {
    setImporter(next: Importer | undefined) {
      importer = next ?? defaultImporter
    },
    setLeaseDriver(next: LeaseDriver | undefined) {
      leaseDriver = next ?? ExtensionLeases
    },
    setTimeouts(next?: { activateMs?: number; serverMs?: number }) {
      activateTimeoutMs = next?.activateMs ?? ACTIVATE_TIMEOUT_MS
      serverTimeoutMs = next?.serverMs ?? SERVER_TIMEOUT_MS
    },
    async reset() {
      clearTimeout(staleHooksTimer)
      staleHooksTimer = undefined
      staleHookIds.clear()
      activateTimeoutMs = ACTIVATE_TIMEOUT_MS
      serverTimeoutMs = SERVER_TIMEOUT_MS
      await disposeAll({ timeoutMs: 100 })
      const canReleasePins = slots.canReleasePins()
      slots.reset()
      serviceDisposals = new WeakMap()
      hookOwner.reset()
      // Explicit test isolation only. Production teardown never drops pins,
      // even after successful strict quiesce: imported raw closures may live.
      const pins = [...generationPins.values(), ...dataPins.values()]
      if (canReleasePins) await Promise.all(pins.map((lease) => lease.release()))
      else for (const lease of pins) retainedTestPins.add(lease)
      generationPins.clear()
      dataPins.clear()
      leaseDriver = ExtensionLeases
      importer = defaultImporter
    },
  },
}

export type ExtensionRuntime = typeof ExtensionRuntime
