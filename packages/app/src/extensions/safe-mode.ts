export function safeModeFromURL(search: string, persistedDisabled: boolean, autoDisabled = false) {
  const value = new URLSearchParams(search).get("extensions")
  if (value === "off") return { disabled: true, persist: true }
  if (value === "on") return { disabled: false, persist: true }
  // An explicit URL parameter wins over both the persisted toggle and the
  // automatic crash-strike safe mode; without one the strikes can still
  // force this launch into safe mode.
  return { disabled: persistedDisabled || autoDisabled, persist: false }
}

// Automatic safe mode ("crash strikes"). A launch where an extension failure
// reaches the page-level error boundary adds one persisted strike; a launch
// that reaches extension readiness clears them. Reaching the threshold arms
// safe mode on the next startup until the user re-enables extensions.
export const EXTENSION_CRASH_THRESHOLD = 2
const CRASH_STORAGE = "opencode.global.dat"
const CRASH_KEY = "extension.safeMode.crashes.v1"
const READ_TIMEOUT_MS = 3_000

export type ExtensionCrashStore = {
  storeGet(name: string, key: string): Promise<string | null>
  storeSet(name: string, key: string, value: string): Promise<void>
}

// Desktop persistence must go through the preload IPC bridge
// (`window.api.storeGet/storeSet`, packages/desktop/src/preload). Browser
// builds have no bridge and degrade to an in-memory counter instead of
// falling back to localStorage.
export function extensionCrashStore(
  target: { api?: Partial<ExtensionCrashStore> } | undefined = typeof window === "undefined"
    ? undefined
    : (window as { api?: Partial<ExtensionCrashStore> }),
): ExtensionCrashStore | undefined {
  const api = target?.api
  if (typeof api?.storeGet !== "function" || typeof api.storeSet !== "function") return undefined
  return { storeGet: api.storeGet.bind(api), storeSet: api.storeSet.bind(api) }
}

export type ExtensionCrashReporter = {
  // Resolves the persisted strike count once; later calls share the result.
  // Never rejects: unreadable storage degrades to the in-memory count.
  load(): Promise<number>
  count(): number
  shouldAutoSafeMode(): boolean
  // Marks that extension code failed during this launch (activation or an
  // extension surface error boundary). Page-level crashes only add a strike
  // when this flag is set, so host bugs unrelated to extensions cannot trip
  // automatic safe mode.
  markExtensionFailure(): void
  // Called by the page-level error boundary; persists one strike when an
  // extension failure was observed this launch. Never rejects.
  recordPageError(): Promise<void>
  // A launch that reached readiness clears persisted strikes.
  startupSucceeded(): Promise<void>
  // The user's "re-enable extensions" action clears the launch flag and the
  // strikes so the next launch starts clean.
  reset(): Promise<void>
}

export function createExtensionCrashReporter(store = extensionCrashStore()): ExtensionCrashReporter {
  let value = 0
  let loaded: Promise<number> | undefined
  let extensionFailure = false

  const read = async () => {
    if (!store) return value
    let raw: string | null
    try {
      const stored = await Promise.race([
        store.storeGet(CRASH_STORAGE, CRASH_KEY),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), READ_TIMEOUT_MS)),
      ])
      if (stored === "timeout") {
        console.warn("[extension-safe-mode] crash counter read timed out")
        return value
      }
      raw = stored
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[extension-safe-mode] crash counter read failed error=${message}`)
      return value
    }
    if (raw === null) return 0
    try {
      const parsed = JSON.parse(raw) as unknown
      return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0
    } catch {
      console.warn(`[extension-safe-mode] crash counter unreadable value=${raw}`)
      return 0
    }
  }

  const persist = async (next: number) => {
    value = next
    if (!store) return
    try {
      await store.storeSet(CRASH_STORAGE, CRASH_KEY, JSON.stringify(next))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[extension-safe-mode] crash counter write failed error=${message}`)
    }
  }

  const load = () => {
    loaded ??= read().then((next) => {
      value = next
      return next
    })
    return loaded.then(() => value)
  }

  return {
    load,
    count: () => value,
    shouldAutoSafeMode: () => value >= EXTENSION_CRASH_THRESHOLD,
    markExtensionFailure() {
      extensionFailure = true
    },
    async recordPageError() {
      if (!extensionFailure) return
      await load()
      const next = value + 1
      console.warn(`[extension-safe-mode] page-level extension error strikes=${next}`)
      await persist(next)
    },
    async startupSucceeded() {
      await load()
      if (value === 0) return
      console.info(`[extension-safe-mode] healthy startup cleared strikes=${value}`)
      await persist(0)
    },
    async reset() {
      extensionFailure = false
      await persist(0)
    },
  }
}

let active: ExtensionCrashReporter | undefined

// The extension host registers its crash reporter here so leaf modules
// (mount.ts, panel-content.tsx) and the app-level error boundary can report
// failures without threading the instance through every layer.
export function registerExtensionCrashReporter(reporter: ExtensionCrashReporter) {
  active = reporter
  return () => {
    if (active === reporter) active = undefined
  }
}

export function markExtensionFailure() {
  try {
    active?.markExtensionFailure()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[extension-safe-mode] failure mark failed error=${message}`)
  }
}

// Called by the app-level error boundary when a render error escapes every
// local boundary. Persistence is fire-and-forget: the page is already dead.
export function notifyExtensionPageError() {
  try {
    void active?.recordPageError()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[extension-safe-mode] page error record failed error=${message}`)
  }
}
