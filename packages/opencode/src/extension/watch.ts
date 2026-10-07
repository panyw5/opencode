import path from "node:path"
import { lstat, readdir, stat } from "node:fs/promises"
// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Hash } from "@/util/hash"
import { lazy } from "@/util/lazy"
import { load, type Loaded } from "./manifest"
import { publish, publishError } from "./event"
import { ExtensionRegistry } from "./registry"
import type { ExtensionID } from "./schema"

const log = Log.create({ service: "extension.watcher" })

export const DEBOUNCE_MS = 300

const WATCH_IGNORE = ["node_modules/**", ".git/**"]
const SERVER_IGNORE = new Set(["node_modules", ".git"])
const MAX_SERVER_FILES = 10_000
const MAX_DIRECTORY_DEPTH = 32

export type WatchEvent = { type: "add" | "update" | "delete"; path: string }
export type WatchCallback = (error: Error | null, events: WatchEvent[]) => void
export type WatchSubscription = { unsubscribe: () => Promise<void> }
export type SubscribeFn = (dir: string, callback: WatchCallback, ignore: string[]) => Promise<WatchSubscription>

export type Target = { id: ExtensionID; dir: string }

export type ExtensionWatcherOptions = {
  /** Coalesce filesystem bursts per directory before re-fingerprinting. Default 300ms. */
  debounceMs?: number
  /** Enabled path-link extensions to watch. Defaults to the extension registry. */
  targets?: () => Promise<Target[]>
  /** Directory subscription backend. Defaults to @parcel/watcher native bindings. */
  subscribe?: SubscribeFn
  /** Manifest loader. Defaults to ExtensionManifest.load. */
  load?: (dir: string) => Promise<Loaded>
  /**
   * Server fingerprint source. Defaults to the manifest's own
   * `serverFingerprint` (package.json + server entry content hash, integrated
   * contract) when the loaded manifest carries one, falling back to a
   * directory walk below on manifests without a server section (P1 baseline).
   */
  serverFingerprint?: (dir: string, loaded: Loaded) => Promise<string>
  /** Web-part change notification. Defaults to publishing `extension.status` state "changed". */
  publishChanged?: (id: ExtensionID, version: string) => void
  /** Failure notification. Defaults to publishing `extension.status` state "error". */
  publishError?: (id: ExtensionID, version: string, error: unknown) => void
  /**
   * Invalidate cached extension hooks before dropping the old server module.
   * The production integration invalidates Plugin/ToolRegistry caches without
   * disposing unrelated sessions; the standalone fallback disposes all instances.
   */
  invalidateInstances?: () => Promise<void>
  /**
   * Process-level runtime reload (dispose old service + drop module cache),
   * e.g. (id) => ExtensionRuntime.reload(id). Optional: absent in the P1
   * baseline, supplied by the integration once the extension runtime exists.
   */
  reloadExtension?: (id: ExtensionID) => Promise<void>
  /** Full override of the server-change pipeline (skips invalidate/reload defaults). */
  onServerChange?: (id: ExtensionID) => Promise<void>
}

export type ExtensionWatcher = {
  /** Rescan targets: subscribe new directories, drop removed or disabled ones. */
  readonly refresh: () => Promise<void>
  /** Unsubscribe everything and clear pending timers and state. */
  readonly stop: () => Promise<void>
  /** Resolve once every scheduled and in-flight run has settled (tests). */
  readonly idle: () => Promise<void>
}

declare const OPENCODE_LIBC: string | undefined

const parcelWatcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${OPENCODE_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding) as typeof import("@parcel/watcher")
  } catch (error) {
    log.error("failed to load extension watcher binding", { error: String(error) })
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

const defaultSubscribe: SubscribeFn = (dir, callback, ignore) => {
  const watcher = parcelWatcher()
  if (!watcher) return Promise.reject(new Error("Native file watcher binding is unavailable"))
  const backend = getBackend()
  if (!backend) return Promise.reject(new Error(`Watcher backend not supported: ${process.platform}`))
  return watcher.subscribe(dir, callback as ParcelWatcher.SubscribeCallback, { ignore, backend })
}

const defaultTargets = async (): Promise<Target[]> =>
  (await ExtensionRegistry.list(() => ""))
    .filter((info) => info.enabled && info.source.type === "path")
    .map((info) => ({ id: info.id, dir: info.source.path }))

// Runs before reload: plugin instance finalizers must observe the OLD modules.
// Failing invalidation aborts the reload so the old runtime stays usable.
async function defaultInvalidateInstances() {
  await InstanceRuntime.disposeAllInstances()
}

function normalizeDirectory(input: string) {
  return input.replaceAll("\\", "/")
}

/**
 * Fingerprint of everything server-relevant in an extension package: every
 * file except node_modules, .git and the web asset root. Web-only rebuilds
 * therefore never trigger a server reload, and server-only rebuilds never
 * change the web version segment. Used only when the manifest carries no
 * server fingerprint of its own.
 */
export async function serverFingerprint(dir: string, webRoot: string | undefined): Promise<string> {
  const root = normalizeDirectory(dir)
  const webPrefix = webRoot ? normalizeDirectory(path.relative(root, normalizeDirectory(webRoot))) : undefined
  const excludedPrefix = webPrefix && !webPrefix.startsWith("..") && !path.isAbsolute(webPrefix) ? webPrefix : undefined
  if (webRoot && !excludedPrefix) {
    log.warn("extension web root is outside the watched directory", { dir: root, webRoot })
  }

  const files: string[] = []
  let truncated = false
  const add = (rel: string) => {
    if (files.length >= MAX_SERVER_FILES) {
      truncated = true
      return
    }
    files.push(rel)
  }

  async function walk(current: string, prefix: string, depth: number): Promise<void> {
    if (truncated || depth > MAX_DIRECTORY_DEPTH) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => undefined)
    if (!entries) return
    for (const entry of entries) {
      if (truncated) return
      if (SERVER_IGNORE.has(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (excludedPrefix && (rel === excludedPrefix || rel.startsWith(`${excludedPrefix}/`))) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full, rel, depth + 1)
        continue
      }
      if (entry.isFile()) {
        add(rel)
        continue
      }
      // Symlinks and unusual entries: follow through stat() and classify.
      const target = await stat(full).catch(() => undefined)
      if (!target) continue
      if (target.isDirectory()) await walk(full, rel, depth + 1)
      else if (target.isFile()) add(rel)
    }
  }

  await walk(root, "", 0)
  if (truncated) log.warn("extension server fingerprint truncated", { dir: root, limit: MAX_SERVER_FILES })
  files.sort()
  const stats = await Promise.all(
    files.map(async (rel) => {
      const fingerprint = await lstat(path.join(root, rel)).then(
        (item) => `${rel}:${item.size}:${Math.floor(item.mtimeMs)}`,
        () => rel,
      )
      return fingerprint
    }),
  )
  return Hash.fast(stats.join("\0"))
}

type DirState = { id: ExtensionID; version: string; web: string; server: string }

export function createWatcher(options: ExtensionWatcherOptions = {}): ExtensionWatcher {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
  const targetsFn = options.targets ?? defaultTargets
  const subscribeFn = options.subscribe ?? defaultSubscribe
  const loadFn = options.load ?? load
  const publishChangedFn =
    options.publishChanged ?? ((id: ExtensionID, version: string) => publish({ id, version, state: "changed" }))
  const publishErrorFn =
    options.publishError ?? ((id: ExtensionID, version: string, error: unknown) => publishError(id, version, error))
  const serverFingerprintFn =
    options.serverFingerprint ??
    (async (dir: string, loaded: Loaded) => {
      const fromManifest = (loaded as Loaded & { serverFingerprint?: string }).serverFingerprint
      if (typeof fromManifest === "string") return fromManifest
      return serverFingerprint(dir, loaded.webRoot)
    })
  // Server change pipeline: invalidate plugin instances first (their
  // finalizers must run against the old modules), then drop the runtime's
  // module cache. Absent reloadExtension (P1 baseline) only invalidates.
  const onServerChange =
    options.onServerChange ??
    (async (id: ExtensionID) => {
      await (options.invalidateInstances ?? defaultInvalidateInstances)()
      await options.reloadExtension?.(id)
    })

  let stopped = false
  const states = new Map<string, DirState>()
  const subscriptions = new Map<string, WatchSubscription>()
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; done: Promise<void> }>()
  const chains = new Map<string, Promise<void>>()
  // Refresh serialization is separate from directory processing queues.
  // Concurrent scans must not create subscriptions that overwrite one another.
  let refreshes: Promise<void> = Promise.resolve()

  function enqueue(dir: string, task: () => Promise<void>): Promise<void> {
    const previous = chains.get(dir) ?? Promise.resolve()
    const next = previous.then(task, task).catch((error) => {
      log.error("extension watch processing failed", { dir, error: String(error) })
    })
    chains.set(dir, next)
    const clear = () => {
      if (chains.get(dir) === next) chains.delete(dir)
    }
    next.then(clear, clear)
    return next
  }

  // Any event in a watched directory schedules one debounced re-fingerprint.
  // While a run is already pending further events are coalesced: fingerprints
  // are state-based, so the scheduled run observes the latest filesystem.
  function schedule(dir: string) {
    if (stopped || timers.has(dir)) return
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    const timer = setTimeout(() => {
      timers.delete(dir)
      enqueue(dir, () => process(dir)).then(settle, settle)
    }, debounceMs)
    timer.unref?.()
    timers.set(dir, { timer, done })
  }

  const callback =
    (dir: string): WatchCallback =>
    (error) => {
      if (error) {
        log.warn("extension watch error", { dir, error: String(error) })
        return
      }
      schedule(dir)
    }

  async function drop(dir: string) {
    states.delete(dir)
    const subscription = subscriptions.get(dir)
    subscriptions.delete(dir)
    await subscription?.unsubscribe().catch(() => undefined)
  }

  async function process(dir: string) {
    if (stopped) return
    const targets = await targetsFn().catch((error) => {
      log.error("extension watcher target scan failed", { dir, error: String(error) })
      return undefined
    })
    if (!targets) return
    if (stopped) return
    const target = targets.find((item) => item.dir === dir)
    if (!target) {
      // Unlinked, removed from the registry, or disabled: stop watching.
      await drop(dir)
      return
    }
    const previous = states.get(dir)
    let loaded: Loaded
    try {
      loaded = await loadFn(target.dir)
    } catch (error) {
      // Broken new version: publish the error and keep the old runtime and
      // old fingerprints so the extension stays usable and the next change
      // retries the load.
      if (previous) publishErrorFn(target.id, previous.version, error)
      else log.warn("extension manifest unavailable", { dir, error: String(error) })
      return
    }
    if (stopped) return
    if (loaded.id !== target.id) {
      if (previous) {
        publishErrorFn(target.id, previous.version, new Error(`Extension id changed from ${target.id} to ${loaded.id}`))
      }
      return
    }
    const next: DirState = {
      id: loaded.id,
      version: loaded.version,
      web: loaded.versionSegment,
      server: await serverFingerprintFn(dir, loaded),
    }
    if (!previous) {
      // Baseline snapshot: never act on state captured before the first look.
      states.set(dir, next)
      return
    }
    const webChanged = previous.web !== next.web
    const serverChanged = previous.server !== next.server
    if (!webChanged && !serverChanged) return
    if (stopped) return
    if (webChanged) publishChangedFn(target.id, loaded.version)
    if (serverChanged) {
      try {
        await onServerChange(target.id)
      } catch (error) {
        // Keep the old runtime usable: revert fingerprints so the next
        // filesystem change retries reload instead of being swallowed.
        states.set(dir, previous)
        publishErrorFn(target.id, loaded.version, error)
        return
      }
    }
    if (stopped) return
    states.set(dir, next)
  }

  async function runRefresh(): Promise<void> {
    if (stopped) return
    const targets = await targetsFn()
    if (stopped) return
    const dirs = new Set<string>()
    const pending: Promise<void>[] = []
    for (const target of targets) {
      const dir = target.dir
      if (dirs.has(dir)) continue
      dirs.add(dir)
      if (stopped) break
      if (!subscriptions.has(dir)) {
        try {
          const subscription = await subscribeFn(dir, callback(dir), WATCH_IGNORE)
          if (stopped) {
            await subscription.unsubscribe().catch(() => undefined)
            return
          }
          subscriptions.set(dir, subscription)
        } catch (error) {
          log.error("failed to watch extension directory", { dir, error: String(error) })
          continue
        }
      }
      if (!states.has(dir)) pending.push(enqueue(dir, () => process(dir)))
    }
    for (const dir of [...subscriptions.keys()]) {
      if (!dirs.has(dir)) pending.push(drop(dir))
    }
    await Promise.allSettled(pending)
  }

  async function refresh(): Promise<void> {
    const run = refreshes.then(() => runRefresh())
    // Preserve caller errors without poisoning subsequent refreshes.
    refreshes = run.catch(() => undefined)
    await run
  }

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true
    for (const { timer } of timers.values()) clearTimeout(timer)
    timers.clear()
    const pending = [...subscriptions.values()].map((subscription) => subscription.unsubscribe().catch(() => undefined))
    subscriptions.clear()
    await Promise.allSettled([...pending, ...chains.values()])
    states.clear()
    chains.clear()
    if (active === result) active = undefined
  }

  async function idle(): Promise<void> {
    for (let round = 0; round < 1000; round++) {
      const pending = [...chains.values(), ...[...timers.values()].map((entry) => entry.done)]
      if (pending.length === 0) return
      await Promise.allSettled(pending)
      if (chains.size === 0 && timers.size === 0) return
    }
  }

  const result: ExtensionWatcher = { refresh, stop, idle }
  return result
}

let active: ExtensionWatcher | undefined

/**
 * Integration entry: start watching the enabled path-link extensions once per
 * process. The caller owns gating (skip CLI/pure mode, only start when
 * extensions are enabled) and lifecycle (call stop() on layer disposal, call
 * refresh() when extensions are linked, enabled or disabled at runtime).
 * Never starts as an import side effect.
 */
export function start(options: ExtensionWatcherOptions = {}): ExtensionWatcher {
  if (active) {
    if (Object.keys(options).length > 0) {
      log.warn("extension watcher already started; ignoring new options")
    }
    return active
  }
  const watcher = createWatcher(options)
  active = watcher
  watcher.refresh().catch((error) => {
    log.error("extension watcher initial scan failed", { error: String(error) })
  })
  return watcher
}

export async function resetForTesting() {
  const current = active
  active = undefined
  await current?.stop()
}

export * as ExtensionWatcher from "./watch"
