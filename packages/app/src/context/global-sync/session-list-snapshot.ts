import type { Session } from "@opencode-ai/sdk/v2/client"

type ListRequest = {
  token: number
  changes: Map<string, Session | undefined>
}

export function mergeSessionListSnapshot(
  snapshot: Session[],
  current: readonly Session[],
  changes: ReadonlyMap<string, Session | undefined>,
) {
  const known = new Map(current.map((session) => [session.id, session]))
  const merged = new Map<string, Session>()
  for (const session of snapshot) {
    if (!session?.id || session.parentID || session.time?.archived) continue
    const cached = known.get(session.id)
    merged.set(session.id, cached && (cached.time?.updated ?? 0) > (session.time?.updated ?? 0) ? cached : session)
  }
  for (const session of current) {
    if (session.parentID && !session.time?.archived) merged.set(session.id, session)
  }
  for (const [id, session] of changes) {
    if (!session || session.time?.archived) merged.delete(id)
    else merged.set(id, session)
  }
  return [...merged.values()]
    .filter((session) => !session.time?.archived)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function createSessionListRequests() {
  const requests = new Map<string, ListRequest>()
  let sequence = 0
  return {
    begin(directory: string) {
      const request = { token: ++sequence, changes: new Map<string, Session | undefined>() }
      requests.set(directory, request)
      console.debug(`[session-list] begin directory=${directory} token=${request.token}`)
      return request
    },
    current(directory: string, request: ListRequest) {
      return requests.get(directory) === request
    },
    record(directory: string, event: { type: string; properties?: unknown }) {
      const request = requests.get(directory)
      if (!request) return
      if (event.type !== "session.created" && event.type !== "session.updated" && event.type !== "session.deleted")
        return
      const info = (event.properties as { info?: Session } | undefined)?.info
      if (!info?.id) return
      request.changes.set(info.id, event.type === "session.deleted" ? undefined : structuredClone(info))
      console.debug(
        `[session-list] event directory=${directory} token=${request.token} type=${event.type} sid=${info.id}`,
      )
    },
    finish(directory: string, request: ListRequest) {
      if (requests.get(directory) !== request) return
      requests.delete(directory)
      console.debug(
        `[session-list] finish directory=${directory} token=${request.token} changes=${request.changes.size}`,
      )
    },
    clear(directory: string, reason: string) {
      const request = requests.get(directory)
      requests.delete(directory)
      console.debug(`[session-list] clear directory=${directory} token=${request?.token ?? "none"} reason=${reason}`)
    },
    clearAll() {
      requests.clear()
    },
    inspect() {
      return requests.size
    },
  }
}
