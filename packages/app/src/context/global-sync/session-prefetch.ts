const key = (directory: string, sessionID: string) => `${directory}\n${sessionID}`

export const SESSION_PREFETCH_TTL = 15_000
export const SESSION_PREFETCH_MAX = 200

type Meta = {
  count: number
  cursor?: string
  complete: boolean
  at: number
}

export function shouldSkipSessionPrefetch(input: { message: boolean; info?: Meta; chunk: number; now?: number }) {
  if (input.message) {
    if (!input.info) return true
    if (input.info.complete) return true
    if (input.info.count > input.chunk) return true
  } else {
    if (!input.info) return false
  }

  return (input.now ?? Date.now()) - input.info.at < SESSION_PREFETCH_TTL
}

const cache = new Map<string, Meta>()
const inflight = new Map<string, Promise<Meta | undefined>>()
const rev = new Map<string, number>()

const version = (id: string) => rev.get(id) ?? 0

export function getSessionPrefetch(directory: string, sessionID: string) {
  return cache.get(key(directory, sessionID))
}

export function getSessionPrefetchPromise(directory: string, sessionID: string) {
  return inflight.get(key(directory, sessionID))
}

export function clearSessionPrefetchInflight() {
  for (const id of inflight.keys()) rev.set(id, version(id) + 1)
  inflight.clear()
}

export function isSessionPrefetchCurrent(directory: string, sessionID: string, value: number) {
  return version(key(directory, sessionID)) === value
}

export function runSessionPrefetch(input: {
  directory: string
  sessionID: string
  task: (value: number) => Promise<Meta | undefined>
}) {
  const id = key(input.directory, input.sessionID)
  const pending = inflight.get(id)
  if (pending) return pending

  const value = version(id)

  const promise = input.task(value).finally(() => {
    const current = inflight.get(id)
    if (current && current !== promise) return
    if (current === promise) inflight.delete(id)
    if (!inflight.has(id) && !cache.has(id)) rev.delete(id)
  })

  inflight.set(id, promise)
  return promise
}

export function setSessionPrefetch(input: {
  directory: string
  sessionID: string
  count: number
  cursor?: string
  complete: boolean
  at?: number
}) {
  const id = key(input.directory, input.sessionID)
  cache.delete(id)
  cache.set(id, {
    count: input.count,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
  })
  while (cache.size > SESSION_PREFETCH_MAX) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
    if (!inflight.has(oldest)) rev.delete(oldest)
  }
}

export function clearSessionPrefetch(directory: string, sessionIDs: Iterable<string>) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const id = key(directory, sessionID)
    const pending = inflight.get(id)
    rev.set(id, version(id) + 1)
    cache.delete(id)
    inflight.delete(id)
    if (!pending) rev.delete(id)
  }
}

export function clearSessionPrefetchDirectory(directory: string) {
  const prefix = `${directory}\n`
  const keys = new Set([...cache.keys(), ...inflight.keys(), ...rev.keys()])
  let removed = 0
  for (const id of keys) {
    if (!id.startsWith(prefix)) continue
    const pending = inflight.get(id)
    rev.set(id, version(id) + 1)
    cache.delete(id)
    inflight.delete(id)
    if (!pending) rev.delete(id)
    removed += 1
  }
  if (removed > 0) console.debug(`[session-prefetch] clear-directory directory=${directory} removed=${String(removed)}`)
}

export function getSessionPrefetchStats() {
  return { cache: cache.size, inflight: inflight.size, revision: rev.size }
}
