export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ConnectionTransport = Readonly<{
  request: FetchLike
  stream: FetchLike
}>

/** Apply Fetch overrides once, before any adapter inspects headers, method or signal. */
export function transportRequest(input: RequestInfo | URL, init?: RequestInit, base?: string): Request {
  const target = typeof input === "string" && base ? new URL(input, base) : input
  return new Request(target, init)
}

export function createRequestFetch(fetcher: FetchLike, log?: (line: string) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = transportRequest(input, init)
    const overrides = input instanceof Request && init !== undefined
    if (overrides) log?.(`[client-transport] request overrides applied method=${request.method}`)
    request.signal.throwIfAborted()
    if (overrides) log?.("[client-transport] dispatch normalized request")
    return fetcher(request)
  }) as typeof fetch
}
