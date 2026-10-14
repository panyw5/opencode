export function createFreshRequestQueue<T>() {
  const entries = new Map<string, { promise: Promise<T>; run: () => Promise<T> | T }>()
  return {
    has(key: string) {
      return entries.has(key)
    },
    enqueue(key: string, pending: Promise<unknown>, run: () => Promise<T> | T, canceled: () => T): Promise<T> {
      const existing = entries.get(key)
      if (existing) {
        existing.run = run
        return existing.promise
      }
      console.debug(`[fresh-request] queue key=${key}`)
      const start = (): T | Promise<T> => {
        const entry = entries.get(key)
        if (!entry || entry.promise !== promise) {
          console.debug(`[fresh-request] discard key=${key}`)
          return canceled()
        }
        entries.delete(key)
        console.debug(`[fresh-request] start key=${key}`)
        return entry.run()
      }
      const promise: Promise<T> = pending.then(start, start)
      entries.set(key, { promise, run })
      return promise
    },
    clear(key: string) {
      entries.delete(key)
    },
    clearPrefix(prefix: string) {
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) entries.delete(key)
      }
    },
    clearAll() {
      entries.clear()
    },
    get size() {
      return entries.size
    },
  }
}
