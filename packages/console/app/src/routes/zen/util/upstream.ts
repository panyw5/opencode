type Reader = ReadableStreamDefaultReader<Uint8Array>
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type UpstreamLifecycle = ReturnType<typeof createUpstreamLifecycle>

export function createUpstreamLifecycle(callerSignal: AbortSignal, options?: { cleanupTimeoutMs?: number }) {
  const controller = new AbortController()
  const cleanupTimeoutMs = options?.cleanupTimeoutMs ?? 1_000
  let reader: Reader | undefined
  let state: "active" | "cancelling" | "completed" = "active"
  let cancelPromise: Promise<void> | undefined
  let callerAborted = callerSignal.aborted
  let cancelReason: unknown

  const removeCallerListener = () => callerSignal.removeEventListener("abort", onCallerAbort)

  const cancel = (reason?: unknown) => {
    if (state === "completed") return Promise.resolve()
    if (cancelPromise) return cancelPromise
    state = "cancelling"
    cancelReason = reason
    removeCallerListener()
    controller.abort(reason)
    cancelPromise = cancelReader(reader, reason, cleanupTimeoutMs).then(() => {
      try {
        reader?.releaseLock()
      } catch {}
    })
    return cancelPromise
  }

  function onCallerAbort() {
    callerAborted = true
    void cancel(callerSignal.reason)
  }

  if (callerSignal.aborted) {
    cancelReason = callerSignal.reason
    controller.abort(cancelReason)
    state = "cancelling"
    cancelPromise = Promise.resolve()
  } else {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true })
  }

  return {
    signal: controller.signal,
    get cancelled() {
      return state === "cancelling"
    },
    get abortedByCaller() {
      return callerAborted
    },
    attach(next: Reader): Promise<void> {
      if (reader) throw new Error("Upstream reader already attached")
      reader = next
      if (state === "cancelling") {
        return cancelReader(next, cancelReason, cleanupTimeoutMs).then(() => {
          try {
            next.releaseLock()
          } catch {}
        })
      }
      return Promise.resolve()
    },
    cancel,
    complete() {
      if (state !== "active") return
      state = "completed"
      removeCallerListener()
      try {
        reader?.releaseLock()
      } catch {}
    },
  }
}

function cancelReader(reader: Reader | undefined, reason: unknown, timeoutMs: number) {
  if (!reader) return Promise.resolve()
  const operation = Promise.resolve(reader.cancel(reason)).catch(() => {})
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs)
    operation.then(() => {
      clearTimeout(timeout)
      try {
        reader.releaseLock()
      } catch {}
      resolve()
    })
  })
}

function abortableDelay(milliseconds: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      return
    }
    if (!signal) {
      setTimeout(resolve, milliseconds)
      return
    }
    const timeout = setTimeout(done, milliseconds)
    signal.addEventListener("abort", abort, { once: true })

    function done() {
      signal?.removeEventListener("abort", abort)
      resolve()
    }

    function abort() {
      clearTimeout(timeout)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
  })
}

export async function cancelResponseBody(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal | null,
  timeoutMs = 1_000,
) {
  const cleanup = Promise.resolve(body?.cancel()).catch(() => {})
  if (!signal) return cleanup
  if (signal.aborted) {
    void cleanup
    throw signal.reason ?? new DOMException("Aborted", "AbortError")
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (result: "complete" | "abort") => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      if (result === "abort") reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      else resolve()
    }
    const abort = () => finish("abort")
    const timeout = setTimeout(() => finish("complete"), timeoutMs)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    cleanup.then(() => finish("complete"))
  })
}

export async function fetchWith429Retry(
  url: string,
  options: RequestInit,
  config: {
    maxRetries: number
    fetcher?: Fetcher
    retryCount?: number
    retryDelay?: (retryCount: number) => number
  },
): Promise<Response> {
  const fetcher = config.fetcher ?? fetch
  const retryCount = config.retryCount ?? 0
  const res = await fetcher(url, options)
  if (res.status !== 429 || retryCount >= config.maxRetries) return res

  await cancelResponseBody(res.body, options.signal)
  await abortableDelay(config.retryDelay?.(retryCount) ?? Math.pow(2, retryCount) * 500, options.signal)
  return fetchWith429Retry(url, options, { ...config, retryCount: retryCount + 1 })
}

export async function readProviderJson(response: Response) {
  if (response.status === 200) {
    const value = await response.json()
    if (value && typeof value === "object" && !Array.isArray(value)) return value
    return providerError(response.status)
  }

  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let truncated = false
  while (reader) {
    const next = await reader.read()
    if (next.done) break
    if (length + next.value.length > 64 * 1024) {
      truncated = true
      await reader.cancel("Provider error body exceeds limit").catch(() => {})
      break
    }
    chunks.push(next.value)
    length += next.value.length
  }
  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  const text = new TextDecoder().decode(joined)
  try {
    const value = truncated ? undefined : JSON.parse(text)
    if (value && typeof value === "object" && !Array.isArray(value)) return value
  } catch {
    // Fall through to the generic, non-sensitive provider error.
  }
  return providerError(response.status)
}

function providerError(status: number) {
  return {
    type: "error",
    error: {
      type: "upstream_error",
      message: `Provider returned HTTP ${status}`,
    },
  }
}
