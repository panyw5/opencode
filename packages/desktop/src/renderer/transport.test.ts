import { describe, expect, test } from "bun:test"
import { createRemoteFetch } from "../../../app/src/remote/bootstrap"
import { createRequestFetch, type FetchLike } from "@opencode-ai/app/services/transport"
import { deferredPort } from "../../../app/src/services/test-utils/runtime-fixtures"

// Use the native Fetch implementation: Happy DOM does not implement Request body overrides.

const adapters = [
  { name: "desktop", create: (fetcher: FetchLike) => createRequestFetch(fetcher) },
  { name: "remote HTTP", create: (fetcher: FetchLike) => createRemoteFetch(() => "csrf", "https://host", fetcher) },
]

for (const adapter of adapters) {
  describe(`${adapter.name} transport conformance`, () => {
    test("applies RequestInit overrides before dispatch and consumes the replacement body only once", async () => {
      const calls: Request[] = []
      const fetcher = adapter.create(async (input) => {
        const request = input as Request
        calls.push(request)
        expect(await request.text()).toBe("replacement")
        expect(request.bodyUsed).toBe(true)
        return new Response("ok")
      })
      const original = new Request("https://host/session", {
        method: "POST",
        headers: { "x-original": "old" },
        body: "original",
      })
      await fetcher(original, { method: "PATCH", headers: { "x-init": "new" }, body: "replacement", cache: "no-store" })
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe("PATCH")
      expect(calls[0].headers.get("x-init")).toBe("new")
      expect(calls[0].headers.has("x-original")).toBe(false)
      expect(calls[0].cache).toBe("no-store")
    })

    test("overrides the input signal and propagates a later abort", async () => {
      const original = new AbortController()
      const override = new AbortController()
      let dispatched: Request | undefined
      const fetcher = adapter.create(async (input) => {
        dispatched = input as Request
        return new Response("ok")
      })
      await fetcher(new Request("https://host/session", { signal: original.signal }), { signal: override.signal })
      original.abort()
      expect(dispatched?.signal.aborted).toBe(false)
      override.abort()
      expect(dispatched?.signal.aborted).toBe(true)
    })

    test("does not dispatch an already aborted request", async () => {
      let calls = 0
      const fetcher = adapter.create(async () => {
        calls++
        return new Response("unexpected")
      })
      const controller = new AbortController()
      controller.abort()
      await expect(fetcher(new Request("https://host/session"), { signal: controller.signal })).rejects.toThrow()
      expect(calls).toBe(0)
    })

    test("does not pre-read a streaming response or translate HTTP denial into success", async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: hello\n\n"))
          controller.close()
        },
      })
      const response = new Response(body, { status: 403 })
      const result = await adapter.create(async () => response)("https://host/global/event")
      expect(result).toBe(response)
      expect(result.bodyUsed).toBe(false)
      expect(result.status).toBe(403)
      expect(await result.text()).toBe("data: hello\n\n")
    })

    test("preserves transport failure rather than returning an empty response", async () => {
      const error = new TypeError("connection unavailable")
      const fetcher = adapter.create(async () => {
        throw error
      })
      await expect(fetcher("https://host/session")).rejects.toBe(error)
    })
  })
}

test("transport diagnostics never include URL credentials, headers or content", async () => {
  const logs: string[] = []
  await createRequestFetch(
    async () => new Response("ok"),
    (line) => logs.push(line),
  )(new Request("https://host/session?token=secret", { headers: { authorization: "secret" } }), {
    method: "POST",
    body: "secret draft",
  })
  expect(logs).toEqual([
    "[client-transport] request overrides applied method=POST",
    "[client-transport] dispatch normalized request",
  ])
})

test("canceling one legacy lookup consumer cannot dispatch its request or cancel another consumer", async () => {
  const port = deferredPort<void, Response>()
  const requests: Request[] = []
  const fetcher = createRemoteFetch(
    () => "csrf",
    "https://host",
    async (input) => {
      const request = input as Request
      if (new URL(request.url).pathname === "/remote/api/directory") return port.run()
      requests.push(request)
      return Response.json([])
    },
  )
  const controller = new AbortController()
  const retired = fetcher("/session?directory=~", { signal: controller.signal })
  const current = fetcher("/session?directory=~")
  expect(port.calls).toHaveLength(1)
  controller.abort()
  await expect(retired).rejects.toThrow()
  port.calls[0].resolve(Response.json({ path: "/host" }))
  await current
  expect(requests).toHaveLength(1)
  expect(new URL(requests[0].url).searchParams.get("directory")).toBe("/host")
})
