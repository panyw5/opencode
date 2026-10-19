export type RemoteSession = {
  authenticated: true
  csrfToken: string
  capabilities?: { remote?: boolean }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

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
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? new URL(input, origin).href : input
    const request = new Request(target, init)
    const url = new URL(request.url, origin)
    if (url.origin !== origin) return fetcher(request)

    const headers = new Headers(request.headers)
    headers.delete("authorization")
    const method = request.method.toUpperCase()
    const csrfToken = getCsrfToken()
    if (csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      headers.set("x-opencode-csrf", csrfToken)
    }
    return fetcher(new Request(request, { headers, credentials: "same-origin" }))
  }) as typeof fetch
}
