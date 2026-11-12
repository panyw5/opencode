import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, getOwner } from "solid-js"
import {
  createExtensionBridge,
  listenExtensionEvents,
  parseExtensionEvent,
  SECRET_MASK,
  type ExtensionEventSource,
} from "./api"
import { makeExtensionContext, type ContextDeps } from "./context"
import type { ExtensionInfo } from "./types"

const serverURL = "http://127.0.0.1:4096"

function fetchMock(respond: (url: URL, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input))
    const requestInit = init ?? {}
    calls.push({ url, init: requestInit })
    const result = respond(url, requestInit)
    return {
      ok: result.status < 400,
      status: result.status,
      text: async () => JSON.stringify(result.body),
      json: async () => result.body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { calls, impl }
}

function bridge(input: { respond?: Parameters<typeof fetchMock>[0]; headers?: Record<string, string> } = {}) {
  const fetch = fetchMock(
    input.respond ??
      ((url) => {
        if (url.pathname.endsWith("/settings"))
          return { status: 200, body: { settings: { apiKey: SECRET_MASK, theme: "dark" } } }
        return { status: 200, body: { result: "pong" } }
      }),
  )
  const instance = createExtensionBridge({
    serverURL: () => serverURL,
    headers: () => input.headers ?? {},
    fetch: fetch.impl,
  })
  return { instance, calls: fetch.calls }
}

// A fetch that never completes on its own and rejects when the request signal
// aborts, so client-side timeout/abort behavior can be observed.
function hangingFetch(calls: Array<RequestInit> = []) {
  return (async (_input: URL | RequestInfo, init?: RequestInit) => {
    calls.push(init ?? {})
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal
      if (!signal) return
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }) as unknown as typeof fetch
}

describe("extension bridge rpc", () => {
  test("posts to the instance rpc endpoint and unwraps the result", async () => {
    const { instance, calls } = bridge()
    const result = await instance.rpc({ extensionID: "test.viewer", method: "echo", input: { n: 1 } })
    expect(result).toBe("pong")
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]!
    expect(`${url}`).toBe(`${serverURL}/extension/test.viewer/rpc/echo`)
    expect(init.method).toBe("POST")
    expect(init.body).toBe(JSON.stringify({ input: { n: 1 } }))
  })

  test("encodes the directory query and the rpc timeout header", async () => {
    const { instance, calls } = bridge()
    await instance.rpc({
      extensionID: "test.viewer",
      method: "save",
      input: { a: true },
      options: { directory: "/tmp/my dir", timeoutMs: 5000 },
    })
    const { url, init } = calls[0]!
    expect(url.searchParams.get("directory")).toBe("/tmp/my dir")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ "x-opencode-rpc-timeout": "5000" })
  })

  test("sends the connection credentials and relays the abort signal", async () => {
    const controller = new AbortController()
    const { instance, calls } = bridge({ headers: { authorization: "Basic dXNlcjpwYXNz" } })
    await instance.rpc({ extensionID: "x", method: "m", options: { signal: controller.signal } })
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Basic dXNlcjpwYXNz" })
    // The request runs on a merged signal, not the caller's raw signal.
    const requestSignal = calls[0]!.init.signal as AbortSignal
    expect(requestSignal).not.toBe(controller.signal)
    expect(requestSignal.aborted).toBe(false)
    // Once the call settles the relay listener is detached: aborting the
    // caller afterwards must not abort the settled request signal.
    controller.abort()
    expect(requestSignal.aborted).toBe(false)
  })

  test("rejects a caller abort instead of waiting for the timeout", async () => {
    const requests: Array<RequestInit> = []
    const instance = createExtensionBridge({
      serverURL: () => serverURL,
      headers: () => ({}),
      fetch: hangingFetch(requests),
      defaultTimeoutMs: 60_000,
    })
    const controller = new AbortController()
    const pending = instance.rpc({ extensionID: "x", method: "m", options: { signal: controller.signal } })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(new Error("caller cancelled"))
    await expect(pending).rejects.toThrow("caller cancelled")
    expect(requests[0]!.signal).toBeInstanceOf(AbortSignal)
  })

  test("rejects a negative or non-finite timeout without sending a request", async () => {
    const { instance, calls } = bridge()
    await expect(instance.rpc({ extensionID: "x", method: "m", options: { timeoutMs: -5 } })).rejects.toThrow(
      "must be a positive number of milliseconds",
    )
    await expect(instance.rpc({ extensionID: "x", method: "m", options: { timeoutMs: Number.NaN } })).rejects.toThrow(
      "must be a positive number of milliseconds",
    )
    await expect(instance.rpc({ extensionID: "x", method: "m", options: { timeoutMs: 0 } })).rejects.toThrow(
      "must be a positive number of milliseconds",
    )
    expect(calls).toHaveLength(0)
  })

  test("aborts a hung rpc with the client-side default timeout", async () => {
    const requests: Array<RequestInit> = []
    const instance = createExtensionBridge({
      serverURL: () => serverURL,
      headers: () => ({}),
      fetch: hangingFetch(requests),
      defaultTimeoutMs: 20,
    })
    await expect(instance.rpc({ extensionID: "x", method: "m" })).rejects.toThrow(
      "Extension RPC timed out after 20ms: x.m",
    )
    // The fallback deadline is advertised to the server as well.
    expect(requests[0]!.headers).toMatchObject({ "x-opencode-rpc-timeout": "20" })
  })

  test("aborts a hung rpc with the explicitly requested timeout", async () => {
    const requests: Array<RequestInit> = []
    const instance = createExtensionBridge({
      serverURL: () => serverURL,
      headers: () => ({}),
      fetch: hangingFetch(requests),
    })
    await expect(instance.rpc({ extensionID: "x", method: "m", options: { timeoutMs: 20 } })).rejects.toThrow(
      "Extension RPC timed out after 20ms: x.m",
    )
    expect(requests[0]!.headers).toMatchObject({ "x-opencode-rpc-timeout": "20" })
  })

  test("encodes rpc ids and methods into single URL segments", async () => {
    const { instance, calls } = bridge()
    await instance.rpc({ extensionID: "a/b", method: "c d" })
    // The encoded URL must stay on the server origin and keep id/method as
    // single path segments (no path traversal through the id).
    expect(calls[0]!.url.origin).toBe(new URL(serverURL).origin)
    expect(calls[0]!.url.pathname).toBe("/extension/a%2Fb/rpc/c%20d")
  })

  test("throws a string error with the server message on failure", async () => {
    const { instance } = bridge({ respond: () => ({ status: 404, body: { message: "no such method" } }) })
    await expect(instance.rpc({ extensionID: "x", method: "m" })).rejects.toThrow(
      "Extension request failed (404: no such method)",
    )
  })
})

describe("extension bridge settings", () => {
  test("patches global settings and returns the updated masked snapshot", async () => {
    const { instance, calls } = bridge()
    const settings = await instance.updateSettings({ extensionID: "test.viewer", patch: { theme: "dark" } })
    expect(settings).toEqual({ apiKey: SECRET_MASK, theme: "dark" })
    const { url, init } = calls[0]!
    expect(`${url}`).toBe(`${serverURL}/global/extension/test.viewer/settings`)
    expect(init.method).toBe("PATCH")
    expect(init.body).toBe(JSON.stringify({ theme: "dark" }))
  })

  test("strips masked secret values from the patch", async () => {
    const { instance, calls } = bridge()
    await instance.updateSettings({ extensionID: "x", patch: { apiKey: SECRET_MASK, theme: "light" } })
    expect(calls[0]!.init.body).toBe(JSON.stringify({ theme: "light" }))
  })

  test("rejects a masked-only response", async () => {
    const { instance } = bridge({ respond: () => ({ status: 200, body: {} }) })
    await expect(instance.updateSettings({ extensionID: "x", patch: { theme: "light" } })).rejects.toThrow(
      "Extension settings response is unavailable: x",
    )
  })
})

describe("extension event payload guard", () => {
  test("parses a valid extension.event payload", () => {
    expect(
      parseExtensionEvent({ type: "extension.event", properties: { id: "a", name: "tick", data: { n: 1 } } }),
    ).toEqual({ id: "a", name: "tick", data: { n: 1 } })
  })

  test("ignores unrelated events and drops malformed ones", () => {
    expect(parseExtensionEvent({ type: "extension.status", properties: {} })).toBeUndefined()
    expect(parseExtensionEvent("nope")).toBeUndefined()
    expect(parseExtensionEvent({ type: "extension.event", properties: { name: "tick" } })).toBeUndefined()
  })
})

type SentEvent = { name: string; details: unknown; domain: string }

function eventSource(initialURL = serverURL) {
  const listeners = new Set<(event: SentEvent) => void>()
  let url = initialURL
  const source: ExtensionEventSource = {
    get url() {
      return url
    },
    listenAll(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    forDomain(domain) {
      if (domain === "other") return { url: "http://elsewhere:4096" }
      return { url }
    },
  }
  return {
    source,
    send(event: SentEvent) {
      for (const listener of listeners) listener(event)
    },
    setURL(next: string) {
      url = next
    },
    size: () => listeners.size,
  }
}

describe("extension event dispatch", () => {
  test("delivers matching events with the directory in meta", () => {
    const bus = eventSource()
    const seen: Array<{ data: unknown; meta: { directory?: string } }> = []
    const dispose = listenExtensionEvents({
      extensionID: "test.viewer",
      name: "tick",
      listener: (data, meta) => seen.push({ data, meta }),
      source: bus.source,
    })
    bus.send({
      name: "global",
      details: { type: "extension.event", properties: { id: "test.viewer", name: "tick", data: 1 } },
      domain: "opencode",
    })
    bus.send({
      name: "/tmp/project",
      details: { type: "extension.event", properties: { id: "test.viewer", name: "tick", data: 2 } },
      domain: "opencode",
    })
    expect(seen).toEqual([
      { data: 1, meta: { directory: undefined } },
      { data: 2, meta: { directory: "/tmp/project" } },
    ])
    dispose()
    expect(bus.size()).toBe(0)
  })

  test("filters by extension id, event name and server", () => {
    const bus = eventSource()
    const seen: unknown[] = []
    listenExtensionEvents({
      extensionID: "test.viewer",
      name: "tick",
      listener: (data) => seen.push(data),
      source: bus.source,
    })
    bus.send({
      name: "global",
      details: { type: "extension.event", properties: { id: "other", name: "tick", data: 1 } },
      domain: "opencode",
    })
    bus.send({
      name: "global",
      details: { type: "extension.event", properties: { id: "test.viewer", name: "tock", data: 2 } },
      domain: "opencode",
    })
    bus.send({
      name: "global",
      details: { type: "extension.event", properties: { id: "test.viewer", name: "tick", data: 3 } },
      domain: "other",
    })
    bus.send({
      name: "global",
      details: { type: "extension.event", properties: { id: "test.viewer", name: "tick", data: 4 } },
      domain: "opencode",
    })
    expect(seen).toEqual([4])
  })

  test("drops malformed payloads instead of invoking the listener", () => {
    const bus = eventSource()
    const seen: unknown[] = []
    listenExtensionEvents({
      extensionID: "test.viewer",
      name: "tick",
      listener: (data) => seen.push(data),
      source: bus.source,
    })
    bus.send({
      name: "global",
      details: { type: "extension.event", properties: { id: "test.viewer" } },
      domain: "opencode",
    })
    expect(seen).toEqual([])
  })

  test("follows the server url and isolates listener failures", () => {
    const bus = eventSource()
    const seen: unknown[] = []
    listenExtensionEvents({
      extensionID: "test.viewer",
      name: "tick",
      listener: (data) => {
        if (data === 1) throw new Error("boom")
        seen.push(data)
      },
      source: bus.source,
    })
    bus.send({
      name: "global",
      details: { type: "extension.event", properties: { id: "test.viewer", name: "tick", data: 1 } },
      domain: "opencode",
    })
    bus.setURL("http://elsewhere:4096")
    bus.send({
      name: "global",
      details: { type: "extension.event", properties: { id: "test.viewer", name: "tick", data: 2 } },
      domain: "other",
    })
    expect(seen).toEqual([2])
  })
})

const settingsManifest = (): ExtensionInfo => ({
  id: "test.bridge",
  version: "1.0.0",
  displayName: "Bridge",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {},
  settings: { apiKey: SECRET_MASK, theme: "dark" },
})

function bridgeContext(input: { manifest?: ExtensionInfo; valid?: boolean } = {}) {
  const calls: string[] = []
  const rpcInputs: Array<{
    method: string
    input?: unknown
    directory?: string
    signal?: AbortSignal
    timeoutMs?: number
  }> = []
  const patches: Array<Record<string, unknown>> = []
  // Mirrors the host: the settings snapshot lives in a signal so the
  // reactive accessors created by `settings.get` re-run when it changes.
  const [settings, setSettings] = createSignal<Record<string, unknown>>(
    input.manifest?.settings ?? settingsManifest().settings ?? {},
  )
  let readCount = 0
  const deps: ContextDeps = {
    manifest: input.manifest ?? settingsManifest(),
    owner: undefined as never,
    valid: () => input.valid ?? true,
    subscriptions: [],
    registerViewer: () => () => calls.push("viewer"),
    registerToolRenderer: () => () => calls.push("tool"),
    registerPanel: () => () => calls.push("panel"),
    registerCommand: () => () => calls.push("command"),
    callRpc: (request) => {
      rpcInputs.push(request)
      return Promise.resolve("ok")
    },
    listenEvents: (name, listener) => {
      calls.push(`listen:${name}`)
      return () => calls.push(`unlisten:${name}`)
    },
    readSetting: (key) => {
      readCount++
      return settings()[key]
    },
    updateSettings: (patch) => {
      patches.push(patch)
      setSettings((current) => ({ ...current, ...patch }))
      return Promise.resolve()
    },
  }
  return { deps, calls, rpcInputs, patches, setSettings, readCount: () => readCount }
}

describe("extension context bridge", () => {
  test("routes rpc.call through the host with options", async () => {
    const root = createRoot((dispose) => {
      const current = getOwner()
      if (!current) throw new Error("owner required")
      return { current, dispose }
    })
    const fixture = bridgeContext()
    fixture.deps.owner = root.current
    const context = makeExtensionContext(fixture.deps)
    const controller = new AbortController()
    await context.rpc.call("echo", { n: 1 }, { directory: "/tmp/x", signal: controller.signal, timeoutMs: 1000 })
    expect(fixture.rpcInputs).toEqual([
      { method: "echo", input: { n: 1 }, directory: "/tmp/x", signal: controller.signal, timeoutMs: 1000 },
    ])
    root.dispose()
  })

  test("registers event listeners as disposables and refuses stale activations", () => {
    const root = createRoot((dispose) => {
      const current = getOwner()
      if (!current) throw new Error("owner required")
      return { current, dispose }
    })
    const fixture = bridgeContext()
    fixture.deps.owner = root.current
    const context = makeExtensionContext(fixture.deps)
    const disposable = context.events.on("tick", () => undefined)
    expect(fixture.calls).toEqual(["listen:tick"])
    disposable.dispose()
    expect(fixture.calls).toEqual(["listen:tick", "unlisten:tick"])

    const stale = bridgeContext({ valid: false })
    stale.deps.owner = root.current
    expect(() => makeExtensionContext(stale.deps).events.on("tick", () => undefined)).toThrow(
      "Extension activation is stale: test.bridge",
    )
    root.dispose()
  })

  test("reads live settings and never exposes plaintext secrets", () => {
    const root = createRoot((dispose) => {
      const current = getOwner()
      if (!current) throw new Error("owner required")
      return { current, dispose }
    })
    const fixture = bridgeContext()
    fixture.deps.owner = root.current
    const context = makeExtensionContext(fixture.deps)
    const theme = context.settings.get<string>("theme")
    const apiKey = context.settings.get<string>("apiKey")
    expect(theme()).toBe("dark")
    expect(apiKey()).toBe(SECRET_MASK)
    const before = fixture.readCount()
    fixture.setSettings({ apiKey: SECRET_MASK, theme: "light" })
    expect(theme()).toBe("light")
    expect(fixture.readCount()).toBeGreaterThan(before)
    root.dispose()
  })

  test("forwards settings patches without merging the whole snapshot", async () => {
    const root = createRoot((dispose) => {
      const current = getOwner()
      if (!current) throw new Error("owner required")
      return { current, dispose }
    })
    const fixture = bridgeContext()
    fixture.deps.owner = root.current
    const context = makeExtensionContext(fixture.deps)
    await context.settings.update({ theme: "light" })
    expect(fixture.patches).toEqual([{ theme: "light" }])
    root.dispose()
  })
})
