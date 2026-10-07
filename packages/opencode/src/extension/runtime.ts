import path from "node:path"
import { pathToFileURL } from "node:url"
import { cp, lstat, mkdir, readlink, readFile, readdir, rename, rm, stat, symlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
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
import { Hash } from "@/util/hash"
import { ExtensionRegistry, NotFoundError } from "./registry"
import { publishError } from "./event"
import { ExtensionID, type Info, type RegistryRow } from "./schema"
import type { Loaded } from "./manifest"

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

// Aliases kept so HTTP layers can map errors without caring which side named them.
export const ExtensionRpcMethodNotFoundError = ExtensionRpcNotFoundError
export const ExtensionRpcHandlerError = ExtensionRpcError

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

type SettingsListener = (next: Record<string, unknown>) => void

type Entry = {
  id: string
  status: "loading" | "ready" | "error"
  error?: string
  manifest?: Loaded
  module?: ServerExtension
  fingerprint?: string
  source?: string
  service?: ExtensionService
  activating?: Promise<ExtensionService | undefined>
  settings: Record<string, unknown>
  settingsListeners: Set<SettingsListener>
  serverUrl?: URL
  instances: Map<string, ExtensionHooks>
  requests: Set<AbortController>
}

function emptyEntry(id: string, settings: Record<string, unknown>): Entry {
  return {
    id,
    status: "loading",
    settings,
    settingsListeners: new Set(),
    instances: new Map(),
    requests: new Set(),
  }
}

/**
 * Context needed to materialize an importable copy of the extension package.
 * `dir` is the package root (the manifest directory), `source` the server
 * entry inside it.
 */
type ImporterContext = { id: string; dir: string }

/**
 * Imports a bundled server entry. Overridable so tests can simulate module
 * replacement.
 *
 * The default implementation copies the whole package into
 * `Global.Path.tmp/extension-modules/<id>/<fingerprint>/` and imports from
 * that fresh real path. Bun normalizes file URL query/hash fragments, so a
 * fixed source URL always returns the cached module and hot reload would
 * never observe new code; only a changed real path produces a fresh module.
 */
type Importer = (source: string, fingerprint: string | undefined, context: ImporterContext) => Promise<ServerExtension>

/** Directory names never copied into the module cache. */
const MODULE_COPY_SKIP = new Set(["node_modules", ".git"])
/** Number of fingerprint copies retained per extension id (current + recent). */
const MODULE_COPY_KEEP = 3
/** Upper bound for a single path segment of the module cache location. */
const MODULE_SEGMENT_MAX = 120

function safeSegment(value: string) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, MODULE_SEGMENT_MAX)
  if (!cleaned || cleaned === "." || cleaned === "..") return "_"
  return cleaned
}

function moduleCopyRoot(id: string) {
  return path.join(Global.Path.tmp, "extension-modules", safeSegment(id))
}

/**
 * Fallback fingerprint for manifests without a `serverFingerprint`: a content
 * hash of the package manifest and server entry, mirroring the integrated
 * contract closely enough to give every version its own copy directory.
 */
async function fallbackFingerprint(context: ImporterContext, source: string) {
  const [pkg, entry] = await Promise.all([
    readFile(path.join(context.dir, "package.json")).catch(() => undefined),
    readFile(source).catch(() => undefined),
  ])
  return Hash.fast(
    Buffer.concat([
      Buffer.from(context.dir),
      Buffer.from("\0"),
      pkg ?? Buffer.alloc(0),
      Buffer.from("\0"),
      entry ?? Buffer.alloc(0),
    ]),
  )
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  )
}

/**
 * Removes old fingerprint copies for an extension, keeping the current one
 * plus the `MODULE_COPY_KEEP - 1` most recently touched siblings. Copying can
 * be concurrent across processes, so pruning never touches the current copy
 * and ignores all failures.
 */
async function pruneModuleCopies(idDir: string, keep: string) {
  const siblings = await readdir(idDir, { withFileTypes: true }).catch(() => undefined)
  if (!siblings) return
  const others: { name: string; mtime: number }[] = []
  for (const sibling of siblings) {
    if (!sibling.isDirectory() || sibling.name === keep) continue
    const info = await stat(path.join(idDir, sibling.name)).catch(() => undefined)
    if (info?.isDirectory()) others.push({ name: sibling.name, mtime: info.mtimeMs })
  }
  others.sort((a, b) => b.mtime - a.mtime)
  for (const victim of others.slice(MODULE_COPY_KEEP - 1)) {
    await rm(path.join(idDir, victim.name), { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Copies the package into `target` (a unique temp dir renamed into place) so
 * concurrent copiers — within this process and across processes — end up with
 * a complete directory no matter who wins the rename. `node_modules` is
 * excluded from the copy but re-linked to the original so bare specifiers
 * keep resolving against the real installed dependencies.
 */
async function copyModule(context: ImporterContext, target: string, relativeEntry: string) {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await cp(context.dir, temp, {
      recursive: true,
      dereference: true,
      filter: (source) => !MODULE_COPY_SKIP.has(path.basename(source)),
    })
    const nodeModules = path.join(context.dir, "node_modules")
    if (
      await stat(nodeModules).then(
        (info) => info?.isDirectory() ?? false,
        () => false,
      )
    ) {
      await symlink(nodeModules, path.join(temp, "node_modules"), "dir")
    }
    if (!(await exists(path.join(temp, relativeEntry)))) {
      throw new Error(`Extension module copy is missing its server entry: ${context.id}`)
    }
    try {
      await rename(temp, target)
    } catch (error) {
      // Only reuse a concurrent winner when its entry is present. A directory
      // left by an interrupted copy is not a valid module cache.
      if (await exists(path.join(target, relativeEntry))) {
        await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      } else {
        const stale = `${target}.${process.pid}.${randomUUID()}.stale`
        try {
          await rename(target, stale)
        } catch {
          if (!(await exists(path.join(target, relativeEntry)))) throw error
          await rm(temp, { recursive: true, force: true }).catch(() => undefined)
          return
        }
        try {
          await rename(temp, target)
        } finally {
          await rm(stale, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await pruneModuleCopies(path.dirname(target), path.basename(target)).catch(() => undefined)
}

/** In-flight copy deduplication keyed by the target directory. */
const moduleCopies = new Map<string, Promise<void>>()

function copyModuleOnce(context: ImporterContext, target: string, relativeEntry: string) {
  const pending = moduleCopies.get(target)
  if (pending) return pending
  const copy = copyModule(context, target, relativeEntry).finally(() => {
    if (moduleCopies.get(target) === copy) moduleCopies.delete(target)
  })
  moduleCopies.set(target, copy)
  return copy
}

/**
 * Reuse-path repair: a copy made by an earlier process carries a node_modules
 * symlink aimed at that process's package, which may have moved or vanished.
 * Re-point dangling or stale links at the current source so bare specifiers
 * keep resolving against the real installed dependencies.
 */
async function refreshNodeModulesLink(context: ImporterContext, target: string) {
  const link = path.join(target, "node_modules")
  const wanted = path.join(context.dir, "node_modules")
  const info = await lstat(link).catch(() => undefined)
  if (!info?.isSymbolicLink()) {
    // Nothing to repair for real directories, and create the link when an
    // older copy predates the symlink step.
    if (
      !info &&
      (await stat(wanted).then(
        (found) => found?.isDirectory() ?? false,
        () => false,
      ))
    ) {
      await symlink(wanted, link, "dir").catch(() => undefined)
    }
    return
  }
  const current = await readlink(link).catch(() => undefined)
  if (
    current === wanted &&
    (await stat(link).then(
      () => true,
      () => false,
    ))
  )
    return
  await rm(link, { force: true }).catch(() => undefined)
  await symlink(wanted, link, "dir").catch(() => undefined)
}

/**
 * Materializes the importable entry path for a server source: a real copy of
 * the package under the fingerprint's own directory. Reuses an intact copy
 * from a previous process when the entry file is already present.
 */
async function moduleEntryPath(context: ImporterContext, source: string, fingerprint: string) {
  const relative = path.relative(context.dir, source)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Extension server entry is outside the package directory: ${context.id}`)
  }
  const target = path.join(moduleCopyRoot(context.id), safeSegment(fingerprint))
  const entry = path.join(target, relative)
  if (await exists(entry)) {
    await refreshNodeModulesLink(context, target)
    return entry
  }
  try {
    await copyModuleOnce(context, target, relative)
  } catch (error) {
    // The winner of a concurrent copy already provides the entry.
    if (await exists(entry)) return entry
    throw error
  }
  return entry
}

async function defaultImporter(source: string, fingerprint: string | undefined, context: ImporterContext) {
  const resolved = fingerprint ?? (await fallbackFingerprint(context, source))
  const entry = await moduleEntryPath(context, source, resolved)
  const module = (await import(pathToFileURL(entry).href)) as { default?: unknown }
  return module.default as ServerExtension
}

let importer: Importer = defaultImporter

const DISPOSE_TIMEOUT_MS = 10_000

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
  try {
    await withTimeout(
      Promise.resolve(service.dispose()).catch((error) => {
        log.error("extension dispose failed", { extension: id, error })
      }),
      timeoutMs,
    )
  } catch (error) {
    log.error("extension dispose failed", { extension: id, error })
  }
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
async function currentSettings(id: ExtensionID, fallback: RegistryRow): Promise<Record<string, unknown> | undefined> {
  const linked = await ExtensionRegistry.linked(id).catch(() => undefined)
  return (linked?.row ?? fallback).settings
}

function cacheDir(id: string) {
  return path.join(Global.Path.cache, "extensions", id)
}

function createHost(entry: Entry, manifest: Loaded, serverUrl: URL | undefined): ExtensionHost {
  if (serverUrl) entry.serverUrl = serverUrl
  const id = manifest.id
  return {
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

async function invalidateHooks() {
  for (const kind of ["tool", "plugin"] as const) {
    await Promise.all([...cacheInvalidators[kind]].map((invalidateCache) => invalidateCache()))
  }
}

const entries = new Map<string, Entry>()
const loading = new Map<string, Promise<Entry | undefined>>()

/**
 * Monotonic per-extension epoch. `disable` and `reload` bump it so work that
 * started earlier (module import, activation) cannot re-insert a stale entry
 * or leave a freshly activated service behind after the teardown happened.
 */
const generations = new Map<string, number>()

function generationOf(id: string) {
  return generations.get(id) ?? 0
}

function invalidate(id: string) {
  generations.set(id, generationOf(id) + 1)
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
    entry.status = "error"
    entry.error = error instanceof Error ? error.message : String(error)
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
async function ensureEntry(manifest: Loaded, row: RegistryRow, serverUrl: URL | undefined): Promise<Entry | undefined> {
  const id = manifest.id
  const source = sourceOf(manifest)
  if (!source) return

  const existing = entries.get(id)
  if (existing) {
    const changed = existing.fingerprint !== manifest.serverFingerprint || existing.source !== source
    if (changed) {
      await reload(id)
    } else if (existing.status === "error") {
      return
    } else if (existing.module) {
      // Re-read the registry so a row snapshot taken before a concurrent
      // settings update cannot clobber the newer values it holds.
      const stored = await currentSettings(id, row)
      // The entry can be disabled or reloaded while the settings were read.
      if (entries.get(id) !== existing) return
      existing.settings = resolveSettings(manifest, stored)
      if (serverUrl) existing.serverUrl = serverUrl
      return existing
    }
  }

  const inflight = loading.get(id)
  if (inflight) {
    const entry = await inflight
    if (entries.get(id) !== entry) return
    return entry
  }

  const gen = generationOf(id)
  const load = importEntry(manifest, source).then(async (entry) => {
    // Re-read so a settings update landing during the import is not lost.
    const stored = await currentSettings(id, row)
    entry.settings = resolveSettings(manifest, stored)
    if (serverUrl) entry.serverUrl = serverUrl
    // A disable/reload during the import must not resurrect the entry.
    if (generationOf(id) === gen) entries.set(id, entry)
    return entry
  })
  loading.set(id, load)
  try {
    const entry = await load
    if (generationOf(id) !== gen || entries.get(id) !== entry) return
    return entry
  } finally {
    if (loading.get(id) === load) loading.delete(id)
  }
}

/**
 * Activates the process-level service for an entry, deduplicating concurrent
 * activations so every caller observes the same service instance. If the
 * extension is disabled or reloaded while activation is in flight, the fresh
 * service is disposed immediately instead of being cached on a stale entry.
 */
async function ensureService(entry: Entry, manifest: Loaded, serverUrl: URL | undefined) {
  if (entry.status === "ready") return entry.service
  if (entry.status === "error") return
  if (entry.activating) return entry.activating

  const id = entry.id
  const gen = generationOf(id)
  const activation = (async () => {
    const host = createHost(entry, manifest, serverUrl)
    const service = ((await entry.module?.activate?.(host)) ?? {}) as ExtensionService
    if (generationOf(id) !== gen) {
      await disposeService(id, service, 0)
      return undefined
    }
    entry.service = service
    entry.status = "ready"
    return service
  })()

  entry.activating = activation
  try {
    return await activation
  } catch (error) {
    entry.status = "error"
    entry.error = error instanceof Error ? error.message : String(error)
    log.error("extension activate failed", { extension: entry.id, error })
    publishError(manifest.id, manifest.version, error)
    return
  } finally {
    entry.activating = undefined
  }
}

/**
 * Disposes late instance hooks with the same bounded timeout as service
 * disposal: the runtime dropped ownership, so a hanging extension dispose
 * must not stall the caller.
 */
async function disposeHooks(id: string, hooks: ExtensionHooks | undefined) {
  if (!hooks?.dispose) return
  try {
    await withTimeout(
      Promise.resolve(hooks.dispose()).catch((error) => {
        log.error("extension instance dispose failed", { extension: id, error })
      }),
      DISPOSE_TIMEOUT_MS,
    )
  } catch (error) {
    log.error("extension instance dispose failed", { extension: id, error })
  }
}

async function callServer(entry: Entry, manifest: Loaded, input: PluginInput) {
  const server = entry.module?.server
  if (!server) return
  const id = entry.id
  const gen = generationOf(id)
  const host = Object.assign(createHost(entry, manifest, input.serverUrl), { service: entry.service })
  const extensionInput = { ...input, extension: host }
  const hooks = ((await server(extensionInput)) ?? {}) as ExtensionHooks
  // A disable/reload while server() was running means the runtime no longer
  // owns the instance: the late hooks are disposed (bounded) instead of being
  // registered on a dead entry.
  if (generationOf(id) !== gen || entries.get(id) !== entry) {
    await disposeHooks(id, hooks)
    return
  }
  const directory = input.directory
  const original = hooks.dispose
  // Instance finalizers run through the plugin dispose path, which the runtime
  // does not own; wrapping the hook keeps the rpc instance map in sync even
  // when the process-level stop is never reached.
  hooks.dispose = async () => {
    if (entry.instances.get(directory) === hooks) entry.instances.delete(directory)
    await original?.call(hooks)
  }
  entry.instances.set(directory, hooks)
  return hooks
}

async function instanceHooks(input: PluginInput, options: { disabled?: boolean } = {}): Promise<InstanceHookEntry[]> {
  if (options.disabled) return []
  let list: Info[]
  try {
    list = await ExtensionRegistry.list(() => "")
  } catch (error) {
    // A corrupt registry file must not break Plugin.state for every instance.
    log.error("extension registry list failed", { error })
    return []
  }
  const result: InstanceHookEntry[] = []
  for (const info of list) {
    if (!info.enabled || info.state !== "ready") continue
    try {
      const linked = await ExtensionRegistry.linked(info.id)
      if (!linked) continue
      const { row, manifest } = linked
      if (!row.enabled || !manifest.serverEntry) continue
      const entry = await ensureEntry(manifest, row, input.serverUrl)
      if (!entry?.module) continue
      const service = await ensureService(entry, manifest, input.serverUrl)
      if (!service) continue
      if (entries.get(manifest.id) !== entry) continue
      const hooks = await callServer(entry, manifest, input)
      // A disable/reload that landed while the hooks were being produced must
      // not surface them for the fresh instance.
      if (!hooks || entries.get(manifest.id) !== entry) continue
      result.push({ id: manifest.id, hooks })
    } catch (error) {
      log.error("extension instance hooks failed", { extension: info.id, error })
    }
  }
  return result
}

async function rpc(call: ExtensionRpcCall): Promise<unknown> {
  const signal = call.signal
  const aborted = () => new ExtensionRpcAbortedError(call.id, call.method)
  if (signal?.aborted) throw aborted()

  const id = ExtensionID.make(call.id)
  const linked = await ExtensionRegistry.linked(id)
  if (signal?.aborted) throw aborted()
  if (!linked) throw new NotFoundError(id)
  const { row, manifest } = linked
  if (!row.enabled || !manifest.serverEntry) throw new ExtensionRpcNotFoundError(call.id, call.method)

  const entry = await ensureEntry(manifest, row, undefined)
  if (signal?.aborted) throw aborted()
  // The entry can be replaced or removed while the import was in flight.
  if (!entry?.module || entries.get(manifest.id) !== entry) throw new ExtensionRpcNotFoundError(call.id, call.method)
  const service = await ensureService(entry, manifest, undefined)
  if (signal?.aborted) throw aborted()
  if (!service || entries.get(manifest.id) !== entry) throw new ExtensionRpcNotFoundError(call.id, call.method)

  const instanceHandler = call.directory ? entry.instances.get(call.directory)?.rpc?.[call.method] : undefined
  const handler: RpcHandler | undefined = instanceHandler ?? service.rpc?.[call.method]
  if (!handler) throw new ExtensionRpcNotFoundError(call.id, call.method)

  const request = new AbortController()
  const cancel = () => request.abort(signal?.reason)
  if (signal?.aborted) cancel()
  else signal?.addEventListener("abort", cancel, { once: true })
  entry.requests.add(request)
  if (request.signal.aborted) {
    entry.requests.delete(request)
    signal?.removeEventListener("abort", cancel)
    throw aborted()
  }
  try {
    return await handler(call.input, {
      directory: call.directory,
      signal: request.signal,
    })
  } catch (error) {
    const normalized = duckTypedRpcError(error)
    if (normalized) throw normalized
    throw error
  } finally {
    entry.requests.delete(request)
    signal?.removeEventListener("abort", cancel)
  }
}

async function disable(id: string, options: { timeoutMs?: number } = {}) {
  invalidate(id)
  // A still-pending import from the previous generation must not be joined by
  // fresh callers: drop it so the next request starts its own load. The stale
  // load's cleanup is identity-guarded, so removing the entry here cannot
  // delete a newer load registered later.
  loading.delete(id)
  const entry = entries.get(id)
  if (!entry) return
  entries.delete(id)
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
  loading.delete(id)
  const entry = entries.get(id)
  entries.delete(id)
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
  const entry = entries.get(id)
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
  const ids = [...entries.keys()]
  await Promise.all(ids.map((id) => disable(id, options)))
}

function describe(id: string) {
  const entry = entries.get(id)
  if (!entry) return
  return {
    hasService: entry.status === "ready",
    hasInstanceHooks: typeof entry?.module?.server === "function",
  }
}

export const ExtensionRuntime = {
  instanceHooks,
  rpc,
  disable,
  reload,
  notifySettings,
  disposeAll,
  describe,
  invalidateHooks,
  registerCacheInvalidator,
  testing: {
    setImporter(next: Importer | undefined) {
      importer = next ?? defaultImporter
    },
    async reset() {
      await disposeAll({ timeoutMs: 100 })
      loading.clear()
      importer = defaultImporter
    },
  },
}

export type ExtensionRuntime = typeof ExtensionRuntime
