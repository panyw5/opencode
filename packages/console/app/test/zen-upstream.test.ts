import { describe, expect, test } from "bun:test"
import {
  cancelResponseBody,
  createUpstreamLifecycle,
  fetchWith429Retry,
  readProviderJson,
} from "../src/routes/zen/util/upstream"

function cancellableReader(onCancel: (reason: unknown) => void) {
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      onCancel(reason)
    },
  }).getReader()
}

describe("zen upstream lifecycle", () => {
  test("propagates caller abort to the fetch signal and reader", async () => {
    const caller = new AbortController()
    const lifecycle = createUpstreamLifecycle(caller.signal)
    const reasons: unknown[] = []
    await lifecycle.attach(cancellableReader((reason) => reasons.push(reason)))

    caller.abort("caller disconnected")
    await lifecycle.cancel()

    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.abortedByCaller).toBe(true)
    expect(reasons).toEqual(["caller disconnected"])
  })

  test("cancels downstream exactly once", async () => {
    const lifecycle = createUpstreamLifecycle(new AbortController().signal)
    const reasons: unknown[] = []
    await lifecycle.attach(cancellableReader((reason) => reasons.push(reason)))

    const first = lifecycle.cancel("consumer stopped")
    const second = lifecycle.cancel("ignored duplicate")
    expect(first).toBe(second)
    await first

    expect(lifecycle.signal.aborted).toBe(true)
    expect(lifecycle.abortedByCaller).toBe(false)
    expect(reasons).toEqual(["consumer stopped"])
  })

  test("cancels a reader attached after an early abort", async () => {
    const caller = new AbortController()
    caller.abort("already gone")
    const lifecycle = createUpstreamLifecycle(caller.signal)
    const reasons: unknown[] = []

    await lifecycle.attach(cancellableReader((reason) => reasons.push(reason)))

    expect(lifecycle.cancelled).toBe(true)
    expect(lifecycle.abortedByCaller).toBe(true)
    expect(reasons).toEqual(["already gone"])
  })

  test("natural completion detaches caller abort without cancelling", async () => {
    const caller = new AbortController()
    const lifecycle = createUpstreamLifecycle(caller.signal)
    const reasons: unknown[] = []
    await lifecycle.attach(cancellableReader((reason) => reasons.push(reason)))

    lifecycle.complete()
    caller.abort("too late")

    expect(lifecycle.signal.aborted).toBe(false)
    expect(lifecycle.cancelled).toBe(false)
    expect(reasons).toEqual([])
  })

  test("bounds cancellation when an upstream reader never settles", async () => {
    const lifecycle = createUpstreamLifecycle(new AbortController().signal, { cleanupTimeoutMs: 1 })
    await lifecycle.attach(
      new ReadableStream<Uint8Array>({
        cancel() {
          return new Promise<void>(() => {})
        },
      }).getReader(),
    )

    await lifecycle.cancel("stuck reader")

    expect(lifecycle.cancelled).toBe(true)
    expect(lifecycle.signal.aborted).toBe(true)
  })
})

describe("zen upstream retry", () => {
  test("bounds a stuck response body cleanup without caller abort", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        return new Promise<void>(() => {})
      },
    })

    await cancelResponseBody(body, new AbortController().signal, 1)

    expect(body.locked).toBe(false)
  })

  test("releases a 429 response before retrying", async () => {
    let calls = 0
    let released = 0
    const fetcher = async () => {
      calls++
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            cancel() {
              released++
            },
          }),
          { status: 429 },
        )
      }
      return new Response("ok")
    }

    const response = await fetchWith429Retry(
      "https://provider.test",
      {},
      {
        maxRetries: 1,
        fetcher,
        retryDelay: () => 0,
      },
    )

    expect(response.status).toBe(200)
    expect(calls).toBe(2)
    expect(released).toBe(1)
  })

  test("aborts during retry backoff", async () => {
    const caller = new AbortController()
    const fetcher = async () => new Response("retry", { status: 429 })
    const pending = fetchWith429Retry(
      "https://provider.test",
      { signal: caller.signal },
      { maxRetries: 1, fetcher, retryDelay: () => 10_000 },
    )

    await Promise.resolve()
    caller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  test("does not wait forever for a stuck 429 body cancellation", async () => {
    const caller = new AbortController()
    const fetcher = async () =>
      new Response(
        new ReadableStream({
          cancel() {
            return new Promise<void>(() => {})
          },
        }),
        { status: 429 },
      )
    const pending = fetchWith429Retry(
      "https://provider.test",
      { signal: caller.signal },
      { maxRetries: 1, fetcher, retryDelay: () => 0 },
    )

    await Promise.resolve()
    caller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("zen upstream response", () => {
  test("keeps JSON provider errors", async () => {
    expect(await readProviderJson(Response.json({ error: { message: "bad request" } }, { status: 400 }))).toEqual({
      error: { message: "bad request" },
    })
  })

  test("replaces non-JSON provider errors without exposing their body", async () => {
    expect(await readProviderJson(new Response("secret upstream body", { status: 503 }))).toEqual({
      type: "error",
      error: {
        type: "upstream_error",
        message: "Provider returned HTTP 503",
      },
    })
  })

  test("wraps null and oversized provider errors in a safe envelope", async () => {
    expect(await readProviderJson(new Response("null", { status: 503 }))).toEqual({
      type: "error",
      error: { type: "upstream_error", message: "Provider returned HTTP 503" },
    })
    expect(await readProviderJson(new Response("x".repeat(65 * 1024), { status: 502 }))).toEqual({
      type: "error",
      error: { type: "upstream_error", message: "Provider returned HTTP 502" },
    })
  })
})
