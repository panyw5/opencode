import { createHash } from "node:crypto"
import { watch as watchDirectory } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

export type RegistryWatchHandle = {
  close(): void
  unref?(): unknown
  on?(event: "error", callback: (error: Error) => void): unknown
}

export type RegistryWatch = (
  directory: string,
  callback: (event: string, filename: string | Buffer | null) => void,
) => RegistryWatchHandle | Promise<RegistryWatchHandle>

export type RegistryObserverOptions = {
  file: string
  /** Opaque token: v2/v3:<revision>, v1:<content SHA-256>, or missing. */
  refresh: (revision: string) => Promise<void>
  intervalMs?: number
  debounceMs?: number
  watch?: RegistryWatch
  onError?: (error: unknown) => void
}

export type RegistryObserver = {
  /** Record the initial snapshot without refreshing, then watch and poll. */
  start(): Promise<void>
  /** Cancel monitoring and wait for in-flight reads, subscriptions and refreshes. */
  stop(): Promise<void>
  /** Deliver the first snapshot explicitly; subsequent calls deduplicate it. */
  refresh(): Promise<void>
}

const nativeWatch: RegistryWatch = (directory, callback) => watchDirectory(directory, { persistent: false }, callback)

function absent(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

// Deliberately do not use ExtensionRegistry: its reads can migrate v1 stores.
async function revision(file: string): Promise<string> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if (absent(error)) return undefined
    throw error
  })
  if (text === undefined) return "missing"
  const store: unknown = JSON.parse(text)
  if (typeof store !== "object" || store === null) throw new Error(`Invalid extension registry: ${file}`)
  if ("version" in store && store.version === 1) {
    return `v1:${createHash("sha256").update(text).digest("hex")}`
  }
  if (
    "version" in store &&
    (store.version === 2 || store.version === 3) &&
    "revision" in store &&
    typeof store.revision === "number" &&
    Number.isSafeInteger(store.revision) &&
    store.revision >= 0
  ) {
    return `v${store.version}:${store.revision}`
  }
  throw new Error(`Invalid extension registry version or revision: ${file}`)
}

export function createRegistryObserver(options: RegistryObserverOptions): RegistryObserver {
  const file = path.resolve(options.file)
  const directory = path.dirname(file)
  const watch = options.watch ?? nativeWatch
  const intervalMs = options.intervalMs ?? 1_000
  const debounceMs = options.debounceMs ?? 100
  let started = false
  let stopped = false
  let delivered = false
  let previous: string | undefined
  let polling: ReturnType<typeof setInterval> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let subscription: { handle: RegistryWatchHandle; identity: string } | undefined
  let tail = Promise.resolve()
  let starting: Promise<void> | undefined
  let stopping: Promise<void> | undefined
  let draining: Promise<void> | undefined
  let pending = false

  function report(error: unknown) {
    // Diagnostics must not break the queue or produce unhandled rejections.
    try {
      options.onError?.(error)
    } catch {}
  }

  function close(handle: RegistryWatchHandle) {
    try {
      handle.close()
    } catch (error) {
      report(error)
    }
  }

  function detach() {
    const current = subscription
    subscription = undefined
    if (current) close(current.handle)
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = tail.then(async () => {
      if (!stopped) await task()
    })
    tail = next.catch(() => {})
    return next
  }

  function schedule() {
    if (!started || stopped || debounce) return
    debounce = setTimeout(() => {
      debounce = undefined
      request()
    }, debounceMs)
    debounce.unref()
  }

  async function attach() {
    if (!started || stopped) return
    try {
      const parent = await stat(directory)
      const identity = `${parent.dev}:${parent.ino}`
      if (stopped || subscription?.identity === identity) return
      detach()
      const handle = await watch(directory, schedule)
      // An injected asynchronous subscription can resolve after stop().
      if (stopped) {
        close(handle)
        return
      }
      const current = { handle, identity }
      subscription = current
      handle.unref?.()
      handle.on?.("error", (error) => {
        if (stopped || subscription !== current) return
        detach()
        report(error)
        schedule()
      })
    } catch (error) {
      detach()
      if (!absent(error)) report(error)
    }
  }

  async function observe(force = false) {
    await attach()
    if (stopped) return
    const current = await revision(file)
    if (stopped || (!force && current === previous)) return
    await options.refresh(current)
    // Failed refreshes leave the previous token untouched, so polling retries.
    previous = current
    delivered = true
  }

  function request() {
    if (!started || stopped) return
    pending = true
    if (draining) return
    draining = enqueue(async () => {
      // Events arriving during an awaited refresh must cause another read.
      while (pending && !stopped) {
        pending = false
        await observe().catch(report)
      }
    })
    void draining.finally(() => {
      draining = undefined
      if (pending && !stopped) request()
    })
  }

  return {
    start() {
      if (stopped) return Promise.resolve()
      if (starting) return starting
      started = true
      starting = enqueue(async () => {
        await attach()
        if (stopped) return
        try {
          if (previous === undefined) previous = await revision(file)
          else await observe()
        } catch (error) {
          report(error)
        }
        if (stopped) return
        polling = setInterval(request, intervalMs)
        polling.unref()
      })
      return starting
    },
    refresh() {
      return enqueue(() => observe(!delivered)).catch((error) => {
        report(error)
        throw error
      })
    },
    stop() {
      if (stopping) return stopping
      stopped = true
      pending = false
      if (polling) clearInterval(polling)
      if (debounce) clearTimeout(debounce)
      polling = undefined
      debounce = undefined
      detach()
      stopping = tail
      return stopping
    },
  }
}
