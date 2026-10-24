import { describe, expect, test } from "bun:test"
import { bootstrapRemoteSession, createRemoteFetch } from "./bootstrap"

describe("remote web bootstrap", () => {
  test("loads the same-origin session without putting credentials in the URL or storage", async () => {
    let called: [RequestInfo | URL, RequestInit | undefined] | undefined
    const session = await bootstrapRemoteSession(async (input, init) => {
      called = [input, init]
      return Response.json({ authenticated: true, csrfToken: "csrf-secret", capabilities: { remote: true } })
    })

    expect(session).toEqual({ authenticated: true, csrfToken: "csrf-secret", capabilities: { remote: true } })
    expect(called?.[0]).toBe("/remote/api/session")
    expect(called?.[1]).toMatchObject({ credentials: "same-origin", cache: "no-store" })
  })

  test("fails closed for unauthenticated and malformed sessions", async () => {
    await expect(bootstrapRemoteSession(async () => new Response("", { status: 401 }))).rejects.toThrow(
      "Remote session is not authenticated",
    )
    await expect(bootstrapRemoteSession(async () => Response.json({ authenticated: true }))).rejects.toThrow(
      "Remote session is not authenticated",
    )
  })

  test("adds CSRF only to same-origin writes and never adds it to reads or external requests", async () => {
    const calls: Request[] = []
    const fetcher = createRemoteFetch(
      () => "csrf-secret",
      "https://remote.example",
      async (input) => {
        calls.push(input instanceof Request ? input : new Request(input))
        return new Response(null, { status: 204 })
      },
    )

    await fetcher("/api/session", { method: "GET" })
    const controller = new AbortController()
    const request = new Request("https://remote.example/api/session", {
      method: "POST",
      body: "original",
      headers: { authorization: "Basic persisted", "x-original": "yes" },
      signal: controller.signal,
    })
    await fetcher(request, { headers: { "x-init": "yes" } })
    await fetcher("https://other.example/ingest", { method: "POST" })

    expect(calls[0].headers.has("x-opencode-csrf")).toBe(false)
    expect(calls[1].headers.get("x-opencode-csrf")).toBe("csrf-secret")
    expect(calls[1].credentials).toBe("same-origin")
    expect(calls[1].headers.has("authorization")).toBe(false)
    expect(calls[1].headers.get("x-init")).toBe("yes")
    expect(calls[1].headers.has("x-original")).toBe(false)
    expect(calls[1].method).toBe("POST")
    expect(await calls[1].text()).toBe("original")
    expect(calls[1].signal).toBe(controller.signal)
    expect(calls[1].headers.has("origin")).toBe(false)
    expect(calls[2].headers.has("x-opencode-csrf")).toBe(false)
  })

  test("distinguishes expired sessions from transient bootstrap failures", async () => {
    await expect(bootstrapRemoteSession(async () => new Response("", { status: 401 }))).rejects.toMatchObject({
      kind: "unauthenticated",
    })
    await expect(bootstrapRemoteSession(async () => new Response("", { status: 503 }))).rejects.toMatchObject({
      kind: "unavailable",
    })
  })
})
