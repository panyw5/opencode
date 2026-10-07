// Per-id mutation locks shared by the extension host's state-changing calls
// (enable/disable and settings updates). Locks are keyed by the server the
// operation was issued against: a server switch must never leave a stale lock
// blocking the same extension id on the new server, while two concurrent
// operations for the same id on the same server stay mutually exclusive.

export type MutationScope = {
  serverURL: string
  id: string
}

// Thrown when a mutation's response arrives but the world it was issued into
// is gone: the host was disposed, or the app switched servers (including an
// A-B-A back to the same url via a recreated connection). Callers can catch
// this class to suppress "success"/"failure" toasts for a stale response —
// the operation belongs to a server the UI is no longer showing.
export class ExtensionMutationStaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExtensionMutationStaleError"
  }
}

export type ExtensionMutationTracker = {
  // Registers an in-flight mutation and returns its release closure. Throws
  // when the same id is already mutating against the same server; the caller
  // must release exactly once (releases are idempotent) in a finally block.
  begin(scope: MutationScope): () => void
  // True while any mutation for the id is in flight, on any server. The host
  // mirrors this into a signal so busy state stays reactive for the UI.
  busy(id: string): boolean
  // Snapshot of ids with at least one in-flight mutation.
  ids(): ReadonlySet<string>
  // Drops every lock held against a server the host no longer tracks, so an
  // operation orphaned by a server switch cannot keep the id marked busy.
  releaseServer(serverURL: string): void
}

export function createExtensionMutationTracker(): ExtensionMutationTracker {
  // id -> set of server URLs with an in-flight mutation for that id.
  const locks = new Map<string, Map<string, symbol>>()
  return {
    begin(scope) {
      const servers = locks.get(scope.id)
      if (servers?.has(scope.serverURL)) {
        throw new Error(`Extension operation already in progress: ${scope.id}`)
      }
      const token = Symbol(scope.id)
      if (servers) servers.set(scope.serverURL, token)
      else locks.set(scope.id, new Map([[scope.serverURL, token]]))
      let released = false
      return () => {
        if (released) return
        released = true
        const servers = locks.get(scope.id)
        if (servers?.get(scope.serverURL) !== token) return
        servers.delete(scope.serverURL)
        if (servers.size === 0) locks.delete(scope.id)
      }
    },
    busy(id) {
      return (locks.get(id)?.size ?? 0) > 0
    },
    ids() {
      return new Set(locks.keys())
    },
    releaseServer(serverURL) {
      for (const [id, servers] of locks) {
        if (!servers.delete(serverURL)) continue
        if (servers.size === 0) locks.delete(id)
      }
    },
  }
}
