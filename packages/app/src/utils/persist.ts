import { Platform, usePlatform } from "@/context/platform"
import { makePersisted, type AsyncStorage, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/core/util/encode"
import { Path, isWindowsDrivePath, isWindowsUNCPath, type PathContext } from "@opencode-ai/core/util/path"
import { createResource, type Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [
  Store<T>,
  SetStoreFunction<T>,
  InitType,
  Accessor<boolean> & { promise: undefined | Promise<any> },
]

type PersistTarget = {
  storage?: string
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
  /** Logical workspace path. Storage is resolved after the desktop platform is known. */
  directory?: string
  /** Explicit filesystem context for remote/virtual workspaces. */
  context?: PathContext
}

const LEGACY_STORAGE = "default.dat"
const GLOBAL_STORAGE = "opencode.global.dat"
const LOCAL_PREFIX = "opencode."
const fallback = new Map<string, boolean>()

const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 8 * 1024 * 1024

type CacheEntry = { value: string; bytes: number }
const cache = new Map<string, CacheEntry>()
const cacheTotal = { bytes: 0 }

function cacheDelete(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cacheTotal.bytes -= entry.bytes
  cache.delete(key)
}

function cachePrune() {
  for (;;) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheTotal.bytes <= CACHE_MAX_BYTES) return
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) return
    cacheDelete(oldest)
  }
}

function cacheSet(key: string, value: string) {
  const bytes = value.length * 2
  if (bytes > CACHE_MAX_BYTES) {
    cacheDelete(key)
    return
  }

  const entry = cache.get(key)
  if (entry) cacheTotal.bytes -= entry.bytes
  cache.delete(key)
  cache.set(key, { value, bytes })
  cacheTotal.bytes += bytes
  cachePrune()
}

function cacheGet(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

function fallbackDisabled(scope: string) {
  return fallback.get(scope) === true
}

function fallbackSet(scope: string) {
  fallback.set(scope, true)
}

function quota(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return true
    if (error.name === "NS_ERROR_DOM_QUOTA_REACHED") return true
    if (error.name === "QUOTA_EXCEEDED_ERR") return true
    if (error.code === 22 || error.code === 1014) return true
    return false
  }

  if (!error || typeof error !== "object") return false
  const name = (error as { name?: string }).name
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  if (name && /quota/i.test(name)) return true

  const code = (error as { code?: number }).code
  if (code === 22 || code === 1014) return true

  const message = (error as { message?: string }).message
  if (typeof message !== "string") return false
  if (/quota/i.test(message)) return true
  return false
}

type Evict = { key: string; size: number }

function evict(storage: Storage, keep: string, value: string) {
  const total = storage.length
  const indexes = Array.from({ length: total }, (_, index) => index)
  const items: Evict[] = []

  for (const index of indexes) {
    const name = storage.key(index)
    if (!name) continue
    if (!name.startsWith(LOCAL_PREFIX)) continue
    if (name === keep) continue
    const stored = storage.getItem(name)
    items.push({ key: name, size: stored?.length ?? 0 })
  }

  items.sort((a, b) => b.size - a.size)

  for (const item of items) {
    storage.removeItem(item.key)
    cacheDelete(item.key)

    try {
      storage.setItem(keep, value)
      cacheSet(keep, value)
      return true
    } catch (error) {
      if (!quota(error)) throw error
    }
  }

  return false
}

function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  try {
    storage.removeItem(key)
    cacheDelete(key)
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  const ok = evict(storage, key, value)
  return ok
}

function snapshot(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (isRecord(defaults)) {
    if (!isRecord(value)) return defaults

    const result: Record<string, unknown> = { ...defaults }
    for (const key of Object.keys(value)) {
      if (key in defaults) {
        result[key] = merge((defaults as Record<string, unknown>)[key], (value as Record<string, unknown>)[key])
      } else {
        result[key] = (value as Record<string, unknown>)[key]
      }
    }
    return result
  }

  return value
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function normalize(defaults: unknown, raw: string, migrate?: (value: unknown) => unknown) {
  const parsed = parse(raw)
  if (parsed === undefined) return
  const migrated = migrate ? migrate(parsed) : parsed
  const merged = merge(defaults, migrated)
  return JSON.stringify(merged)
}

function updateTime(value: unknown): number | undefined {
  if (!isRecord(value)) return
  const direct = [value.updatedAt, value.updated, value.modifiedAt, value.timestamp].find(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  )
  if (direct !== undefined) return direct
  for (const key of ["time", "meta", "session"]) {
    const nested = value[key]
    const time = updateTime(nested)
    if (time !== undefined) return time
  }
}

function mergeMigrated(values: unknown[]) {
  if (values.length === 0) return
  const timed = values
    .map((value, index) => ({ value, index, time: updateTime(value) }))
    .filter((item): item is { value: unknown; index: number; time: number } => item.time !== undefined)
  if (timed.length > 0) {
    return snapshot(timed.sort((a, b) => b.time - a.time || b.index - a.index)[0]!.value)
  }

  let result = values[0]
  for (const value of values.slice(1)) {
    result = isRecord(result) && isRecord(value) ? merge(result, value) : value
  }
  return snapshot(result)
}

function rawWorkspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(dir) ?? "0"
  return `opencode.workspace.${head}.${sum}.dat`
}

function isWindowsLocal(context: PathContext | undefined, dir: string): context is PathContext & { platform: "win32"; kind: "local-filesystem" } {
  return (
    context?.platform === "win32" &&
    context.kind === "local-filesystem" &&
    (isWindowsDrivePath(dir) || isWindowsUNCPath(dir))
  )
}

function workspaceStorage(dir: string, context?: PathContext) {
  if (!isWindowsLocal(context, dir)) return rawWorkspaceStorage(dir)
  const identity = Path.identity(dir, context) as string
  const head = (identity.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(identity) ?? "0"
  return `opencode.workspace.${head}.${sum}.dat`
}

function legacyWorkspaceStorages(dir: string, context: PathContext | undefined, current: string) {
  if (!isWindowsLocal(context, dir)) return []

  // Old releases used the raw route/workspace string as the checksum input.
  // Keep every known spelling readable, but never delete those files. The route
  // slug is included because Prompt/Comments/Terminal historically received it.
  const logical = Path.logical(dir, context) as string
  const native = Path.native(dir, context) as string
  const forward = logical.replace(/\\/g, "/")
  const driveCase = (value: string) => {
    const match = value.match(/^([A-Za-z]):/)
    if (!match) return [value]
    return [value, `${match[1]!.toLowerCase()}:${value.slice(2)}`, `${match[1]!.toUpperCase()}:${value.slice(2)}`]
  }
  const candidates = new Set<string>()
  for (const value of [dir, logical, native, forward]) {
    for (const variant of driveCase(value)) {
      candidates.add(variant)
      candidates.add(variant.toLowerCase())
      candidates.add(variant.replace(/\\/g, "/"))
      candidates.add(variant.replace(/\\/g, "/").toLowerCase())
      candidates.add(variant.replace(/\//g, "\\"))
      candidates.add(variant.replace(/\//g, "\\").toLowerCase())
    }
  }
  for (const value of Array.from(candidates)) candidates.add(Path.route.encode(value) as string)
  return Array.from(candidates)
    .map((value) => rawWorkspaceStorage(value))
    .filter((value, index, all) => value !== current && all.indexOf(value) === index)
}

function targetStorage(config: PersistTarget, context?: PathContext) {
  if (!config.directory) return config.storage
  return workspaceStorage(config.directory, config.context ?? context)
}

function targetLegacyStorages(config: PersistTarget, context: PathContext | undefined, current: string | undefined) {
  if (!config.directory) return []
  return legacyWorkspaceStorages(config.directory, config.context ?? context, current ?? "")
}

function persistDebug(event: string, details: Record<string, unknown>) {
  if (import.meta.env.DEV) console.debug(`[persist] ${event}`, details)
}

function localStorageWithPrefix(prefix: string): SyncStorage {
  const base = `${prefix}:`
  const scope = `prefix:${prefix}`
  const item = (key: string) => base + key
  return {
    getItem: (key) => {
      const name = item(key)
      const cached = cacheGet(name)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(name)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(name, stored)
      return stored
    },
    setItem: (key, value) => {
      const name = item(key)
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, name, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      const name = item(key)
      cacheDelete(name)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(name)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

function localStorageDirect(): SyncStorage {
  const scope = "direct"
  return {
    getItem: (key) => {
      const cached = cacheGet(key)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(key)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(key, stored)
      return stored
    },
    setItem: (key, value) => {
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, key, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      cacheDelete(key)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(key)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

export const PersistTesting = {
  localStorageDirect,
  localStorageWithPrefix,
  normalize,
  workspaceStorage,
  rawWorkspaceStorage,
  legacyWorkspaceStorages,
  mergeMigrated,
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: GLOBAL_STORAGE, key, legacy }
  },
  workspace(dir: string, key: string, legacy?: string[], context?: PathContext): PersistTarget {
    return { storage: workspaceStorage(dir, context), key: `workspace:${key}`, legacy, directory: dir, context }
  },
  session(dir: string, session: string, key: string, legacy?: string[], context?: PathContext): PersistTarget {
    return { storage: workspaceStorage(dir, context), key: `session:${session}:${key}`, legacy, directory: dir, context }
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[], context?: PathContext): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy, context)
    return Persist.workspace(dir, key, legacy, context)
  },
}

export function removePersisted(target: Pick<PersistTarget, "storage" | "key" | "directory" | "context">, platform?: Platform) {
  const isDesktop = platform?.platform === "desktop" && !!platform.storage
  const context = target.context
  const storageName = targetStorage(target, context)

  if (isDesktop) {
    return platform.storage?.(storageName)?.removeItem(target.key)
  }

  if (!storageName) {
    localStorageDirect().removeItem(target.key)
    return
  }

  localStorageWithPrefix(storageName).removeItem(target.key)
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
): PersistedWithReady<T> {
  const platform = usePlatform()
  const config: PersistTarget = typeof target === "string" ? { key: target } : target

  // Workspace kind is intentionally explicit. The desktop host OS is not
  // authoritative when a Windows client connects to a remote workspace.
  const pathContext = config.context
  const resolvedStorage = targetStorage(config, pathContext)
  const legacyStorages = targetLegacyStorages(config, pathContext, resolvedStorage)

  if (config.directory && resolvedStorage && resolvedStorage !== config.storage) {
    persistDebug("storage-resolved", {
      directory: config.directory,
      storage: resolvedStorage,
      legacyStorages,
      platform: pathContext?.platform,
      kind: pathContext?.kind,
    })
  }

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []

  const isDesktop = platform.platform === "desktop" && !!platform.storage

  const currentStorage = (() => {
    if (isDesktop) return platform.storage?.(resolvedStorage)
    if (!resolvedStorage) return localStorageDirect()
    return localStorageWithPrefix(resolvedStorage)
  })()

  const legacyStorage = (() => {
    if (!isDesktop) return localStorageDirect()
    if (!resolvedStorage) return platform.storage?.()
    return platform.storage?.(LEGACY_STORAGE)
  })()

  const storage = (() => {
    if (!isDesktop) {
      const current = currentStorage as SyncStorage
      const legacyStore = legacyStorage as SyncStorage

      const api: SyncStorage = {
        getItem: (key) => {
          const raw = current.getItem(key)
          if (raw !== null) {
            const next = normalize(defaults, raw, config.migrate)
            if (next === undefined) {
              current.removeItem(key)
              return null
            }
            if (raw !== next) current.setItem(key, next)
            return next
          }

          for (const legacyKey of legacy) {
            const legacyRaw = legacyStore.getItem(legacyKey)
            if (legacyRaw === null) continue

            const next = normalize(defaults, legacyRaw, config.migrate)
            if (next === undefined) {
              legacyStore.removeItem(legacyKey)
              continue
            }
            current.setItem(key, next)
            legacyStore.removeItem(legacyKey)
            return next
          }

          return null
        },
        setItem: (key, value) => {
          current.setItem(key, value)
        },
        removeItem: (key) => {
          current.removeItem(key)
        },
      }

      return api
    }

    const current = currentStorage as AsyncStorage
    const legacyStore = legacyStorage as AsyncStorage | undefined
    const migrationStores = [
      ...(legacyStore ? [{ name: LEGACY_STORAGE, store: legacyStore }] : []),
      ...legacyStorages
        .filter((name) => name !== LEGACY_STORAGE && name !== resolvedStorage)
        .map((name) => ({ name, store: platform.storage?.(name) }))
        .filter((item): item is { name: string; store: AsyncStorage } => !!item.store),
    ]

    const api: AsyncStorage = {
      getItem: async (key) => {
        const raw = await current.getItem(key)
        if (raw !== null) {
          const next = normalize(defaults, raw, config.migrate)
          if (next === undefined) {
            await current.removeItem(key).catch(() => undefined)
            return null
          }
          if (raw !== next) await current.setItem(key, next)
          return next
        }

        if (migrationStores.length === 0) return null

        // Legacy workspace files remain untouched so users can roll back for a
        // full release cycle. Only the new identity-keyed file is written.
        const keys = [key, ...legacy.filter((item) => item !== key)]
        const migrated: Array<{ name: string; legacyKey: string; value: unknown }> = []
        for (const candidate of migrationStores) {
          for (const legacyKey of keys) {
            const legacyRaw = await candidate.store.getItem(legacyKey)
            if (legacyRaw === null) continue

            const next = normalize(defaults, legacyRaw, config.migrate)
            if (next === undefined) continue
            const value = parse(next)
            if (value !== undefined) migrated.push({ name: candidate.name, legacyKey, value })
          }
        }

        const next = mergeMigrated(migrated.map((item) => item.value))
        if (next === undefined) return null
        const serialized = JSON.stringify(next)
        await current.setItem(key, serialized)
        persistDebug("legacy-migrated", {
          directory: config.directory,
          fromStorage: migrated.map((item) => `${item.name}:${item.legacyKey}`),
          toStorage: resolvedStorage,
          key,
          count: migrated.length,
        })
        return serialized

      },
      setItem: async (key, value) => {
        await current.setItem(key, value)
      },
      removeItem: async (key) => {
        await current.removeItem(key)
      },
    }

    return api
  })()

  const [state, setState, init] = makePersisted(store, { name: config.key, storage })

  const isAsync = init instanceof Promise
  const [ready] = createResource(
    () => init,
    async (initValue) => {
      if (initValue instanceof Promise) await initValue
      return true
    },
    { initialValue: !isAsync },
  )

  return [
    state,
    setState,
    init,
    Object.assign(() => ready() === true, {
      promise: init instanceof Promise ? init : undefined,
    }),
  ]
}
