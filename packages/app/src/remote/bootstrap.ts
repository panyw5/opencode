import { transportRequest, type FetchLike } from "../services/transport"

export type RemoteSession = {
  authenticated: true
  csrfToken: string
  capabilities?: { remote?: boolean; presence?: boolean }
}

export class RemoteSessionError extends Error {
  constructor(readonly kind: "unauthenticated" | "unavailable") {
    super(kind === "unauthenticated" ? "Remote session is not authenticated" : "Remote session is unavailable")
  }
}

export async function bootstrapRemoteSession(fetcher: FetchLike = fetch): Promise<RemoteSession> {
  const response = await fetcher("/remote/api/session", { credentials: "same-origin", cache: "no-store" })
  if (response.status === 401 || response.status === 403) throw new RemoteSessionError("unauthenticated")
  if (!response.ok) throw new RemoteSessionError("unavailable")
  let session: Partial<RemoteSession>
  try {
    session = (await response.json()) as Partial<RemoteSession>
  } catch {
    throw new RemoteSessionError("unavailable")
  }
  if (session.authenticated !== true || typeof session.csrfToken !== "string" || !session.csrfToken) {
    throw new RemoteSessionError("unauthenticated")
  }
  return session as RemoteSession
}

export function createRemoteFetch(getCsrfToken: () => string | undefined, origin: string, fetcher: FetchLike = fetch) {
  const directories = new Map<string, Promise<string>>()
  const resolveDirectory = (directory: string) => {
    const pending = directories.get(directory)
    if (pending) return pending
    console.debug("[remote-fetch] directory resolution start")
    const lookup = (async () => {
      const url = new URL("/remote/api/directory", origin)
      url.search = new URLSearchParams({ path: directory, mode: "validate" }).toString()
      const response = await fetcher(new Request(url, { credentials: "same-origin" }), {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      })
      console.debug(`[remote-fetch] directory resolution status=${response.status}`)
      if (!response.ok) throw new Error(`Directory request failed (${response.status})`)
      const result = (await response.json()) as { path?: unknown }
      if (typeof result.path !== "string" || !result.path || result.path.startsWith("~")) {
        throw new Error("Invalid host directory response")
      }
      console.debug("[remote-fetch] directory resolution completed")
      return result.path
    })().catch((error) => {
      directories.delete(directory)
      console.debug("[remote-fetch] directory resolution failed")
      throw error
    })
    directories.set(directory, lookup)
    return lookup
  }

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = transportRequest(input, init, origin)
    const url = new URL(request.url, origin)
    if (url.origin !== origin) return fetcher(request)

    const headers = new Headers(request.headers)
    headers.delete("authorization")
    // Older remote clients persisted display paths as project identities. Resolve
    // those on the host before the SDK sends them to directory-scoped routes.
    const queryDirectory = url.searchParams.get("directory")
    const headerDirectory = headers.get("x-opencode-directory")
    const directory = queryDirectory ?? (headerDirectory ? decodeURIComponent(headerDirectory) : undefined)
    const tilde = directory === "~" || /^~[\\/]/.test(directory ?? "")
    if (tilde) {
      // A shared host lookup outlives any one consumer, but an aborted consumer
      // must release its SDK request immediately instead of waiting for the host.
      request.signal.throwIfAborted()
      const lookup = resolveDirectory(directory!)
      const canonical = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(request.signal.reason)
        request.signal.addEventListener("abort", abort, { once: true })
        void lookup.then(resolve, reject).finally(() => request.signal.removeEventListener("abort", abort))
      })
      if (queryDirectory !== null) url.searchParams.set("directory", canonical)
      if (headerDirectory) headers.set("x-opencode-directory", encodeURIComponent(canonical))
      console.debug(`[remote-fetch] directory request normalized method=${request.method}`)
    }
    const method = request.method.toUpperCase()
    const csrfToken = getCsrfToken()
    if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("x-opencode-csrf", csrfToken)
    }
    const normalized = tilde ? new Request(url, request) : request
    normalized.signal.throwIfAborted()
    return fetcher(new Request(normalized, { headers, credentials: "same-origin" }))
  }) as typeof fetch
}
