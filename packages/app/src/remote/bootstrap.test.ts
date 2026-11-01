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

  test("resolves persisted tilde directories on the host and deduplicates concurrent lookups", async () => {
    const calls: Request[] = []
    const fetcher = createRemoteFetch(
      () => "csrf-secret",
      "https://remote.example",
      async (input, init) => {
        const request = input as Request
        calls.push(request)
        if (new URL(request.url).pathname === "/remote/api/directory") {
          expect(new URL(request.url).searchParams.get("path")).toBe("~/apps/repo")
          expect(new URL(request.url).searchParams.get("mode")).toBe("validate")
          expect(request.credentials).toBe("same-origin")
          expect(init?.cache).toBe("no-store")
          expect(request.headers.has("authorization")).toBe(false)
          return Response.json({ path: "/host/apps/repo", entries: [] })
        }
        return Response.json([])
      },
    )
    await Promise.all([
      fetcher("/session?directory=~%2Fapps%2Frepo&roots=true"),
      fetcher("/path?directory=~%2Fapps%2Frepo"),
    ])
    expect(calls).toHaveLength(3)
    for (const request of calls.slice(1)) {
      expect(new URL(request.url).searchParams.get("directory")).toBe("/host/apps/repo")
    }
    expect(new URL(calls[1].url).searchParams.get("roots")).toBe("true")
    await fetcher("/session", {
      method: "POST",
      headers: { "x-opencode-directory": encodeURIComponent("~/apps/repo"), authorization: "Basic stale" },
      body: JSON.stringify({ title: "QA" }),
    })
    expect(calls).toHaveLength(4)
    expect(calls[3].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/host/apps/repo"))
    expect(calls[3].headers.get("x-opencode-csrf")).toBe("csrf-secret")
    expect(calls[3].headers.has("authorization")).toBe(false)
    expect(await calls[3].json()).toEqual({ title: "QA" })
  })

  test("retries failed directory resolution without forwarding an unresolved path", async () => {
    let lookups = 0
    let sessions = 0
    const fetcher = createRemoteFetch(
      () => undefined,
      "https://remote.example",
      async (input) => {
        if (new URL((input as Request).url).pathname === "/remote/api/directory") {
          lookups++
          return lookups === 1 ? new Response(null, { status: 401 }) : Response.json({ path: "/host" })
        }
        sessions++
        return Response.json([])
      },
    )
    await expect(fetcher("/session?directory=~")).rejects.toThrow("Directory request failed (401)")
    expect(sessions).toBe(0)
    await fetcher("/session?directory=~")
    expect(lookups).toBe(2)
    expect(sessions).toBe(1)
  })

  test("does not resolve absolute directories or directories belonging to another origin", async () => {
    const calls: Request[] = []
    const fetcher = createRemoteFetch(
      () => undefined,
      "https://remote.example",
      async (input) => {
        calls.push(input as Request)
        return Response.json([])
      },
    )
    await fetcher("/session?directory=%2Fhost%2Frepo")
    await fetcher("https://other.example/session?directory=~%2Frepo")
    expect(calls).toHaveLength(2)
    expect(new URL(calls[1].url).searchParams.get("directory")).toBe("~/repo")
  })
})
