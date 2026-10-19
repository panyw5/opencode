import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type Server, type ServerResponse } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { gzipSync } from "node:zlib"
import { RemoteAuth, type RemoteAuthSnapshot } from "./auth"
import { RemoteConnections } from "./connections"
import { createRemoteGateway } from "./gateway"
import { routePolicy } from "./policy"
import { RemoteUploadLimit } from "./proxy"

const running: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of running.splice(0)) await close()
})

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no server address")
  return `http://127.0.0.1:${address.port}`
}

async function fixture(
  handler: (path: string, response: import("node:http").ServerResponse) => void = () => {},
  options: {
    gzipConfig?: boolean
    leakyGlobalEvent?: boolean
    upstream?: () => { url: string; username: string; password: string } | undefined
    onRequest?: (path: string) => void
    intercept?: (path: string, request: import("node:http").IncomingMessage, response: ServerResponse) => boolean
    saveAuth?: (snapshot: RemoteAuthSnapshot) => Promise<void>
    onLog?: (line: string) => void
  } = {},
) {
  const upstream = createServer((request, response) => {
    options.onRequest?.(request.url ?? "")
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`)
    expect(request.headers.cookie).toBeUndefined()
    expect(request.headers["x-forwarded-for"]).toBeUndefined()
    expect(request.headers["x-opencode-csrf"]).toBeUndefined()
    const path = new URL(request.url ?? "/", "http://test").pathname
    if (options.intercept?.(path, request, response)) return
    if (request.url === "/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.write("data: open\n\n")
      handler(request.url, response)
      return
    }
    if (request.url === "/global/event" && options.leakyGlobalEvent) {
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      const safe = `data: ${JSON.stringify({ id: "message-1", payload: { type: "message.updated", properties: { text: "配置🙂 stays intact" } } })}\n\n`
      const secret = `data: ${JSON.stringify({ directory: "global", payload: { type: "global.config.updated", properties: { provider: { sample: { options: { apiKey: "split-provider-secret" } } }, providers: { sample: { options: { apiKey: "plural-provider-secret" } } }, mcp: { servers: { remote: { url: "https://mcp-user:mcp-password@mcp.example/?token=mcp-url-secret", headers: { "X-Custom": "mcp-header-secret" }, env: { API_SECRET: "mcp-env-secret" } } } }, headers: { "X-Custom": "config-header-secret" }, env: { AWS_ACCESS_KEY_ID: "config-env-secret" }, endpoint: "https://event-user:event-password@api.example/?token=event-url-secret&region=us", theme: "dark" } } })}\n\n`
      const bytes = Buffer.from(safe + secret)
      void (async () => {
        for (let offset = 0; offset < bytes.length; offset += 7) {
          response.write(bytes.subarray(offset, offset + 7))
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
        response.end()
      })()
      return
    }
    if (new URL(request.url ?? "/", "http://test").pathname === "/config") {
      response.setHeader("Content-Type", "application/json")
      const body = JSON.stringify({
        provider: { secret: "hide" },
        providers: { sample: { options: { apiKey: "plural-provider-secret" } } },
        mcp: {
          servers: {
            sample: {
              url: "https://mcp-user:mcp-password@mcp.example/?access_token=mcp-url-secret",
              headers: { "X-Custom": "mcp-header-secret" },
              env: { AWS_ACCESS_KEY_ID: "mcp-env-secret" },
            },
          },
        },
        headers: { "X-Custom": "config-header-secret" },
        env: { AWS_ACCESS_KEY_ID: "config-env-secret" },
        endpoint: "https://endpoint-user:endpoint-password@api.example/v1?token=endpoint-url-secret&region=us",
        apiKey: "hide",
        mode: "ok",
      })
      if (options.gzipConfig) {
        expect(request.headers["accept-encoding"]).toBe("identity")
        response.setHeader("Content-Encoding", "gzip")
        return response.end(gzipSync(body))
      }
      return response.end(body)
    }
    if (request.url === "/provider") {
      response.setHeader("Content-Type", "application/json")
      return response.end(
        JSON.stringify({
          all: [
            {
              id: "sample",
              name: "Sample Provider",
              source: "config",
              env: ["PROVIDER_API_KEY"],
              key: "provider-key-secret",
              options: {
                headers: { "X-Custom": "provider-header-secret" },
                env: { API_TOKEN: "provider-env-secret" },
                apiKey: "provider-option-secret",
              },
              models: {
                "safe-model": {
                  id: "safe-model",
                  providerID: "sample",
                  name: "Safe Model",
                  api: { url: "https://api-user:api-password@provider.example/?token=provider-url-secret" },
                  capabilities: { temperature: true, reasoning: true, toolcall: true },
                  cost: { input: 1, output: 2 },
                  limit: { context: 128000, output: 8000 },
                  status: "active",
                  options: { headers: { "X-Custom": "model-header-secret" } },
                  headers: { "X-Custom": "model-header-secret" },
                  variants: { high: { reasoningEffort: "high" } },
                },
              },
            },
          ],
          default: { sample: "safe-model" },
          connected: ["sample"],
        }),
      )
    }
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ ok: true }))
  })
  const upstreamUrl = await listen(upstream)
  const webRoot = await mkdtemp(join(tmpdir(), "remote-gateway-"))
  await writeFile(join(webRoot, "index.html"), "<main>remote client</main>")
  await mkdir(join(webRoot, "assets"))
  await writeFile(join(webRoot, "assets", "app.123.js"), "self.app=true")
  let saved: RemoteAuthSnapshot = { version: 1, devices: [] }
  const gateway = await createRemoteGateway({
    upstream: options.upstream ?? (() => ({ url: upstreamUrl, username: "user", password: "pass" })),
    webRoot,
    saveAuth: async (snapshot) => {
      if (options.saveAuth) return options.saveAuth(snapshot)
      saved = snapshot
    },
    log: (line) => {
      if (line.includes("pass") || line.includes("hide")) throw new Error("sensitive gateway log")
      options.onLog?.(line)
    },
    allowHttpForTests: true,
  })
  gateway.setPublicOrigin("https://remote.example")
  running.push(async () => {
    await gateway.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await rm(webRoot, { recursive: true, force: true })
  })
  return { gateway, upstream, getSaved: () => saved }
}

async function pair(base: string, gateway: Awaited<ReturnType<typeof createRemoteGateway>>) {
  const invitation = await gateway.createPairing("https://remote.example")
  const code = invitation.url.split("#")[1]
  const response = await fetch(`${base}/remote/api/pair/redeem`, {
    method: "POST",
    headers: { Origin: "https://remote.example", "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: "Test phone" }),
  })
  const cookie = response.headers.get("set-cookie")?.split(";")[0]
  return { response, cookie, code }
}

describe("remote gateway", () => {
  test("authenticates presence locally with Origin/CSRF, isolates devices and never persists page metadata", async () => {
    const upstreamCalls: string[] = []
    const logs: string[] = []
    const { gateway, getSaved } = await fixture(() => {}, {
      onRequest: (path) => upstreamCalls.push(path),
      onLog: (line) => logs.push(line),
    })
    const payload = {
      clientID: "browser-tab-000001",
      sequence: 1,
      visible: true,
      page: { kind: "session", project: "QA", sessionID: "ses_example" },
    }
    const endpoint = `${gateway.url}/remote/api/presence`
    const first = await pair(gateway.url, gateway)
    await pair(gateway.url, gateway)
    const session = (await fetch(`${gateway.url}/remote/api/session`, { headers: { Cookie: first.cookie! } }).then(
      (r) => r.json(),
    )) as { csrfToken: string; capabilities: { presence: boolean } }
    expect(session.capabilities.presence).toBe(true)
    const headers = {
      Cookie: first.cookie!,
      Origin: "https://remote.example",
      "Content-Type": "application/json",
      "x-opencode-csrf": session.csrfToken,
    }
    expect((await fetch(endpoint, { method: "POST", body: JSON.stringify(payload) })).status).toBe(401)
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body: JSON.stringify(payload),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { ...headers, "x-opencode-csrf": "" },
          body: JSON.stringify(payload),
        })
      ).status,
    ).toBe(403)
    expect((await fetch(endpoint, { method: "GET", headers })).status).toBe(405)
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, page: { kind: "invalid" } }),
        })
      ).status,
    ).toBe(400)
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const devices = gateway.devices()
    expect(devices[0].connection?.state).toBe("active")
    expect(devices[0].connection?.pages[0].sessionID).toBe("ses_example")
    expect(devices[1].connection?.state).toBe("unknown")
    expect(upstreamCalls).toEqual([])
    expect(JSON.stringify(getSaved())).not.toMatch(/connection|pages|ses_example|browser-tab/)
    expect(logs.join("\n")).not.toMatch(/ses_example|browser-tab|QA/)
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...payload, sequence: 2, closed: true }),
        })
      ).status,
    ).toBe(200)
    expect(gateway.devices()[0].connection?.state).toBe("offline")
    await gateway.revoke(devices[0].id)
    expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(payload) })).status).toBe(401)
  })

  test("supports the frontend session-scoped permission reply without weakening authentication or CSRF", async () => {
    const path = "/session/session-1/permissions/permission-1"
    const replies: unknown[] = []
    const logs: string[] = []
    const { gateway } = await fixture(() => {}, {
      onLog: (line) => logs.push(line),
      intercept: (route, request, response) => {
        if (route !== path) return false
        let body = ""
        request.on("data", (chunk) => {
          body += chunk
        })
        request.on("end", () => {
          replies.push(JSON.parse(body))
          response.setHeader("Content-Type", "application/json")
          response.end("true")
        })
        return true
      },
    })
    expect(routePolicy("POST", path)).toBe("write")
    expect(
      (await fetch(gateway.url + path, { method: "POST", body: JSON.stringify({ response: "once" }) })).status,
    ).toBe(401)
    const paired = await pair(gateway.url, gateway)
    const session = (await fetch(`${gateway.url}/remote/api/session`, { headers: { Cookie: paired.cookie! } }).then(
      (r) => r.json(),
    )) as { csrfToken: string }
    const headers = {
      Cookie: paired.cookie!,
      Origin: "https://remote.example",
      "Content-Type": "application/json",
      "x-opencode-csrf": session.csrfToken,
    }
    expect(
      (
        await fetch(gateway.url + path, {
          method: "POST",
          headers: { ...headers, Origin: "https://untrusted.example" },
          body: JSON.stringify({ response: "once" }),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await fetch(gateway.url + path, {
          method: "POST",
          headers: { ...headers, "x-opencode-csrf": "" },
          body: JSON.stringify({ response: "once" }),
        })
      ).status,
    ).toBe(403)
    expect(replies).toHaveLength(0)
    for (const response of ["once", "always", "reject"]) {
      const result = await fetch(gateway.url + path, { method: "POST", headers, body: JSON.stringify({ response }) })
      expect(result.status).toBe(200)
      expect(await result.json()).toBe(true)
    }
    expect(replies).toEqual([{ response: "once" }, { response: "always" }, { response: "reject" }])
    for (const method of ["GET", "DELETE", "PATCH"]) expect(routePolicy(method, path)).toBe("deny")
    for (const route of [path + "/extra", "/session/session-1/permissions", "/session/session-1/shell"]) {
      expect((await fetch(gateway.url + route, { method: "POST", headers, body: "{}" })).status).toBe(403)
    }
    expect(logs.every((line) => /^[a-z0-9-]+(?: [a-zA-Z0-9_.=-]+)*$/.test(line))).toBe(true)
    expect(logs.some((line) => line.includes("reason=origin-or-csrf"))).toBe(true)
    expect(logs.some((line) => line.includes("response-start") && line.includes("status=200"))).toBe(true)
    expect(logs.join("\n")).not.toContain(session.csrfToken)
  })

  test("keeps separate hard limits for config and catalog responses and reports the size failure before aborting", async () => {
    for (const [path, limit] of [
      ["/config", 2 * 1024 * 1024],
      ["/provider", 32 * 1024 * 1024],
    ] as const) {
      const logs: string[] = []
      const { gateway } = await fixture(() => {}, {
        onLog: (line) => logs.push(line),
        intercept: (route, _request, response) => {
          if (route !== path) return false
          response.writeHead(200, { "Content-Type": "application/json", "Content-Length": limit + 1 })
          response.end("{}")
          return true
        },
      })
      const paired = await pair(gateway.url, gateway)
      const response = await fetch(`${gateway.url}${path}?directory=private-workspace-name`, {
        headers: { Cookie: paired.cookie! },
      })
      expect(response.status).toBe(502)
      expect(await response.text()).toBe("Upstream response exceeds remote gateway limit")
      expect(
        logs.some((line) => line.includes(`route=${path.replaceAll("/", "_")}`) && line.includes(`limit=${limit}`)),
      ).toBe(true)
      expect(logs.join("\n")).not.toContain("private-workspace-name")
      expect(logs.join("\n")).not.toContain(paired.cookie!)
    }
  })

  test("caps decompressed catalogs instead of allowing compressed oversized JSON through", async () => {
    const body = gzipSync(JSON.stringify({ padding: "x".repeat(32 * 1024 * 1024) }))
    const { gateway } = await fixture(() => {}, {
      intercept: (path, _request, response) => {
        if (path !== "/provider") return false
        response.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" })
        response.end(body)
        return true
      },
    })
    const paired = await pair(gateway.url, gateway)
    const response = await fetch(`${gateway.url}/provider`, { headers: { Cookie: paired.cookie! } })
    expect(response.status).toBe(502)
    expect(await response.text()).toBe("Invalid upstream response")
    expect(response.headers.get("content-encoding")).toBeNull()
  })

  test("rejects oversized chunked config before exposing its body", async () => {
    const logs: string[] = []
    const body = JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) })
    const { gateway } = await fixture(() => {}, {
      onLog: (line) => logs.push(line),
      intercept: (path, _request, response) => {
        if (path !== "/config") return false
        response.writeHead(200, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" })
        response.flushHeaders()
        response.write(body)
        response.end()
        return true
      },
    })
    const paired = await pair(gateway.url, gateway)
    const response = await fetch(`${gateway.url}/config`, { headers: { Cookie: paired.cookie! } })
    expect(response.status).toBe(502)
    expect(await response.text()).toBe("Upstream response exceeds remote gateway limit")
    expect(logs.some((line) => line.includes("response-limit") && line.includes("stage=encoded"))).toBe(true)
  })

  test("forwards a realistic multi-megabyte model catalog without removing models or exposing credentials", async () => {
    const models = Object.fromEntries(
      Array.from({ length: 10000 }, (_, index) => {
        const id = `model-${index}`
        return [
          id,
          {
            id,
            providerID: "bulk",
            name: `Catalog model ${index}`,
            release_date: "2026-10-01",
            capabilities: { toolcall: true, reasoning: true },
            cost: { input: 1, output: 2 },
            limit: { context: 128000, output: 8000 },
            options: { apiKey: "catalog-private-credential", privatePadding: "p".repeat(500) },
          },
        ]
      }),
    )
    const body = JSON.stringify({
      all: [{ id: "bulk", name: "Bulk provider", models }],
      connected: ["bulk"],
      default: { bulk: "model-9999" },
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(6 * 1024 * 1024)
    for (const compressed of [false, true]) {
      const { gateway } = await fixture(() => {}, {
        intercept: (path, _request, response) => {
          if (path !== "/provider") return false
          response.setHeader("Content-Type", "application/json")
          if (compressed) response.setHeader("Content-Encoding", "gzip")
          response.end(compressed ? gzipSync(body) : body)
          return true
        },
      })
      const paired = await pair(gateway.url, gateway)
      const response = await fetch(`${gateway.url}/provider?directory=project`, { headers: { Cookie: paired.cookie! } })
      expect(response.status).toBe(200)
      const safe = await response.text()
      const catalog = JSON.parse(safe)
      expect(catalog.connected).toEqual(["bulk"])
      expect(Object.keys(catalog.all[0].models)).toHaveLength(10000)
      expect(catalog.all[0].models["model-9999"].name).toBe("Catalog model 9999")
      expect(catalog.all[0].models["model-9999"].limit.context).toBe(128000)
      expect(safe).not.toContain("catalog-private-credential")
      expect(safe).not.toContain("privatePadding")
      expect(response.headers.get("content-encoding")).toBeNull()
    }
  })

  test("redeems a pairing code once and persists only token hashes", async () => {
    const { gateway } = await fixture()
    const invitation = await gateway.createPairing("https://remote.example")
    const code = invitation.url.split("#")[1]
    const redeem = () =>
      fetch(`${gateway.url}/remote/api/pair/redeem`, {
        method: "POST",
        headers: { Origin: "https://remote.example", "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
    const results = await Promise.all([redeem(), redeem()])
    expect(results.map((response) => response.status).sort()).toEqual([200, 401])
    const body = (await results.find((response) => response.status === 200)!.json()) as { device: { id: string } }
    expect(gateway.devices()).toHaveLength(1)
    expect(body.device.id).toBe(gateway.devices()[0].id)
    const session = await fetch(`${gateway.url}/remote/api/session`, {
      headers: {
        Cookie: results
          .find((r) => r.status === 200)!
          .headers.get("set-cookie")!
          .split(";")[0],
      },
    })
    expect(session.status).toBe(200)
  })

  test("expires pairing codes and makes only a hash-backed device snapshot", async () => {
    let now = 1_000
    let persisted: unknown
    const auth = new RemoteAuth(
      async (snapshot) => {
        persisted = snapshot
      },
      undefined,
      () => now,
    )
    const pairing = auth.createPairing()
    now += 5 * 60_000
    expect(await auth.redeem(pairing.code, "phone")).toBeUndefined()
    const valid = auth.createPairing()
    const redeemed = await auth.redeem(valid.code, "phone")
    expect(redeemed?.token).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(persisted)).not.toContain(redeemed!.token)
    expect(await auth.redeem(valid.code, "phone")).toBeUndefined()
  })

  test("expires persisted device tokens, restores shared expiry metadata, and throttles last-seen writes", async () => {
    let now = 1_000
    const snapshots: RemoteAuthSnapshot[] = []
    const auth = new RemoteAuth(
      async (snapshot) => {
        snapshots.push(snapshot)
      },
      undefined,
      () => now,
    )
    const redeemed = await auth.redeem(auth.createPairing().code, "phone")
    expect(redeemed?.device.expiresAt).toBe(now + 30 * 24 * 60 * 60_000)
    const snapshot = snapshots.at(-1)!
    const restored = new RemoteAuth(
      async () => {},
      snapshot,
      () => now,
    )
    expect(restored.authenticate(redeemed!.token)?.expiresAt).toBe(redeemed!.device.expiresAt)
    now += 60_000
    expect(restored.authenticate(redeemed!.token)?.lastSeenAt).toBe(now)
    now = redeemed!.device.expiresAt
    expect(restored.authenticate(redeemed!.token)).toBeUndefined()
    expect(restored.devices()).toHaveLength(0)
    const invalid = { ...snapshot, devices: [{ ...snapshot.devices[0], lastSeenAt: Number.NaN }] }
    expect(
      new RemoteAuth(
        async () => {},
        invalid,
        () => 2_000,
      ).devices(),
    ).toHaveLength(0)
  })

  test("serializes immutable auth snapshots so revoke cannot be undone by a delayed pair write", async () => {
    let releaseFirst: (() => void) | undefined
    let firstStarted: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const persisted: RemoteAuthSnapshot[] = []
    const auth = new RemoteAuth(async (snapshot) => {
      if (persisted.length === 0) {
        firstStarted!()
        await firstGate
      }
      persisted.push(snapshot)
    })
    const redemption = auth.redeem(auth.createPairing().code, "phone")
    await started
    const device = auth.devices()[0]
    const revoke = auth.revoke(device.id)
    releaseFirst!()
    expect(await redemption).toBeUndefined()
    await revoke
    expect(persisted.at(-1)?.devices).toEqual([])
    expect(auth.devices()).toEqual([])
  })

  test("enforces origin and CSRF and redacts bootstrap credentials", async () => {
    const { gateway } = await fixture()
    const paired = await pair(gateway.url, gateway)
    expect(paired.response.status).toBe(200)
    const session = await fetch(`${gateway.url}/remote/api/session`, { headers: { Cookie: paired.cookie! } })
    const state = (await session.json()) as { csrfToken: string }
    const noOrigin = await fetch(`${gateway.url}/session`, { headers: { Cookie: paired.cookie! } })
    expect(noOrigin.status).toBe(200)
    const write = (origin: string, csrf: string) =>
      fetch(`${gateway.url}/session`, {
        method: "POST",
        headers: {
          Cookie: paired.cookie!,
          Origin: origin,
          "x-opencode-csrf": csrf,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    expect((await write("https://evil.example", state.csrfToken)).status).toBe(403)
    expect((await write("https://remote.example", "bad")).status).toBe(403)
    expect((await write("https://remote.example", state.csrfToken)).status).toBe(200)
    const config = (await fetch(`${gateway.url}/config`, { headers: { Cookie: paired.cookie! } }).then((response) =>
      response.json(),
    )) as Record<string, unknown>
    expect(config.apiKey).toBeUndefined()
    expect(config.provider).toBeUndefined()
    expect(config.providers).toBeUndefined()
    expect(config.mcp).toBeUndefined()
    expect(config.headers).toBeUndefined()
    expect(config.env).toBeUndefined()
    expect(config.mode).toBe("ok")
    expect(JSON.stringify(config)).not.toContain("endpoint-password")
    expect(JSON.stringify(config)).not.toContain("endpoint-url-secret")
    expect(JSON.stringify(config)).toContain("region=us")
  })

  test("redacts queried compressed config and prevents auth-token query forwarding", async () => {
    let upstreamPath = ""
    const { gateway } = await fixture(() => {}, {
      gzipConfig: true,
      onRequest: (path) => {
        upstreamPath = path
      },
    })
    const paired = await pair(gateway.url, gateway)
    const configResponse = await fetch(`${gateway.url}/config?directory=x`, { headers: { Cookie: paired.cookie! } })
    const config = (await configResponse.json()) as Record<string, unknown>
    expect(configResponse.headers.get("cache-control")).toBe("no-store")
    expect(config.provider).toBeUndefined()
    expect(config.apiKey).toBeUndefined()
    expect(config.mode).toBe("ok")
    await fetch(`${gateway.url}/provider?auth_token=visitor-secret`, { headers: { Cookie: paired.cookie! } })
    expect(upstreamPath).toBe("/provider")
    const catalog = (await fetch(`${gateway.url}/provider`, { headers: { Cookie: paired.cookie! } }).then((response) =>
      response.json(),
    )) as any
    const model = catalog.all[0].models["safe-model"]
    const serialized = JSON.stringify(catalog)
    for (const secret of [
      "provider-key-secret",
      "provider-header-secret",
      "provider-env-secret",
      "provider-option-secret",
      "provider-url-secret",
      "model-header-secret",
      "api-password",
    ]) {
      expect(serialized).not.toContain(secret)
    }
    expect(catalog.all[0].id).toBe("sample")
    expect(catalog.all[0].name).toBe("Sample Provider")
    expect(model.name).toBe("Safe Model")
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.limit.context).toBe(128000)
    expect(model.variants.high.reasoningEffort).toBe("high")
  })

  test("redacts secret-bearing config events incrementally while preserving ordinary SSE events", async () => {
    const { gateway } = await fixture(() => {}, { leakyGlobalEvent: true })
    const paired = await pair(gateway.url, gateway)
    const response = await fetch(`${gateway.url}/global/event`, { headers: { Cookie: paired.cookie! } })
    const body = await response.text()
    for (const secret of [
      "split-provider-secret",
      "plural-provider-secret",
      "mcp-password",
      "mcp-url-secret",
      "mcp-header-secret",
      "mcp-env-secret",
      "config-header-secret",
      "config-env-secret",
      "event-password",
      "event-url-secret",
    ])
      expect(body).not.toContain(secret)
    expect(body).toContain("global.config.updated")
    expect(body).toContain("配置🙂 stays intact")
    const frames = body.split(/\r?\n\r?\n/).filter((frame) => frame.includes("data:"))
    const events = frames.map((frame) =>
      JSON.parse(
        frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n"),
      ),
    )
    const config = events.find((event) => event.payload?.type === "global.config.updated")
    expect(config.payload.properties.provider).toBeUndefined()
    expect(config.payload.properties.providers).toBeUndefined()
    expect(config.payload.properties.mcp).toBeUndefined()
    expect(config.payload.properties.headers).toBeUndefined()
    expect(config.payload.properties.env).toBeUndefined()
    expect(config.payload.properties.endpoint).toBe("https://api.example/?region=us")
  })

  test("allows only authenticated bootstrap reads and permission/question replies", async () => {
    const { gateway } = await fixture()
    const paired = await pair(gateway.url, gateway)
    const session = (await fetch(`${gateway.url}/remote/api/session`, { headers: { Cookie: paired.cookie! } }).then(
      (response) => response.json(),
    )) as { csrfToken: string }
    for (const path of [
      "/global/config",
      "/path",
      "/vcs",
      "/agent",
      "/command",
      "/skill",
      "/permission",
      "/question",
      "/mcp",
      "/lsp",
      "/file/status",
      "/file/content?path=README.md",
      "/file?path=.",
      "/global/health",
      "/experimental/session?roots=true",
      "/scheduled-task",
      "/scheduled-task/task-1",
      "/scheduled-task/task-1/run",
      "/project-task",
      "/project-task/task-1",
      "/project-task/task-1/detail",
      "/session/session-1/user-message-index",
      "/session/session-1/hooks",
    ]) {
      expect((await fetch(`${gateway.url}${path}`, { headers: { Cookie: paired.cookie! } })).status).toBe(200)
    }
    const headers = {
      Cookie: paired.cookie!,
      Origin: "https://remote.example",
      "x-opencode-csrf": session.csrfToken,
      "Content-Type": "application/json",
    }
    for (const path of ["/permission/request-1/reply", "/question/request-1/reply", "/question/request-1/reject"]) {
      expect((await fetch(`${gateway.url}${path}`, { method: "POST", headers, body: "{}" })).status).toBe(200)
    }
    for (const [method, path] of [
      ["POST", "/experimental/session"],
      ["POST", "/experimental/session/session-1/background"],
      ["POST", "/scheduled-task"],
      ["POST", "/scheduled-task/task-1/run-now"],
      ["PATCH", "/scheduled-task/task-1"],
      ["POST", "/project-task"],
      ["PATCH", "/project-task/task-1"],
      ["GET", "/experimental/session/search"],
    ]) {
      expect(
        (await fetch(`${gateway.url}${path}`, { method, headers, body: method === "GET" ? undefined : "{}" })).status,
      ).toBe(403)
    }
    expect((await fetch(`${gateway.url}/global/config`, { headers: { Cookie: paired.cookie! } })).status).toBe(200)
  })

  test("denies admin routes, encoded paths, and upgrades by default", async () => {
    const { gateway } = await fixture()
    const paired = await pair(gateway.url, gateway)
    const headers = { Cookie: paired.cookie! }
    expect((await fetch(`${gateway.url}/remote/api/session`)).status).toBe(401)
    expect((await fetch(`${gateway.url}/project`)).status).toBe(401)
    expect((await fetch(`${gateway.url}/provider/auth`, { headers })).status).toBe(403)
    expect((await fetch(`${gateway.url}/pty`, { headers })).status).toBe(403)
    expect((await fetch(`${gateway.url}/provider/auth`, { headers: { Accept: "text/html" } })).status).toBe(403)
    expect((await fetch(`${gateway.url}/session`, { headers: { Accept: "text/html" } })).status).toBe(401)
    expect((await fetch(`${gateway.url}/`, { headers: { Accept: "text/html" } })).status).toBe(401)
    expect((await fetch(`${gateway.url}/%2f%2fexample.com`, { headers })).status).toBe(400)
    expect((await fetch(`${gateway.url}/session?directory=%2e%2e`, { headers })).status).toBe(200)
    expect(routePolicy("PATCH", "/config")).toBe("deny")
  })

  test("revoking a device closes active event streams", async () => {
    let streamClosed: (() => void) | undefined
    const { gateway } = await fixture((_path, response) => {
      streamClosed = () => response.end()
    })
    const paired = await pair(gateway.url, gateway)
    const deviceId = gateway.devices()[0].id
    const controller = new AbortController()
    const stream = fetch(`${gateway.url}/event`, { headers: { Cookie: paired.cookie! }, signal: controller.signal })
    const response = await stream
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await gateway.revoke(deviceId)
    const closed = await Promise.race([
      reader.read().catch(() => ({ done: true })),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])
    expect(closed).not.toBe("timeout")
    controller.abort()
    streamClosed?.()
  })

  test("gateway close ends active streams and is safe to call again", async () => {
    const { gateway } = await fixture()
    const paired = await pair(gateway.url, gateway)
    const stream = await fetch(`${gateway.url}/event`, { headers: { Cookie: paired.cookie! } })
    const reader = stream.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await gateway.close()
    const closed = await Promise.race([
      reader.read().catch(() => ({ done: true })),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ])
    expect(closed).not.toBe("timeout")
    await gateway.close()
  })

  test("rejects oversized uploads before opening a sidecar request", async () => {
    const sidecarRequests: string[] = []
    const { gateway } = await fixture(() => {}, { onRequest: (path) => sidecarRequests.push(path) })
    const paired = await pair(gateway.url, gateway)
    const state = (await fetch(`${gateway.url}/remote/api/session`, { headers: { Cookie: paired.cookie! } }).then(
      (response) => response.json(),
    )) as { csrfToken: string }
    const response = await fetch(`${gateway.url}/session`, {
      method: "POST",
      headers: {
        Cookie: paired.cookie!,
        Origin: "https://remote.example",
        "x-opencode-csrf": state.csrfToken,
        "Content-Type": "application/json",
        "Content-Length": "100",
      },
      body: Buffer.alloc(16 * 1024 * 1024 + 1, 1),
    })
    expect(response.status).toBe(413)
    expect(sidecarRequests).toEqual([])
  })

  test("counts chunked upload bytes across partial request chunks", () => {
    const upload = new RemoteUploadLimit(10)
    expect(upload.consume(4)).toBe(true)
    expect(upload.consume(5)).toBe(true)
    expect(upload.consume(2)).toBe(false)
    expect(new RemoteUploadLimit(10).consume(Number.NaN)).toBe(false)
  })

  test("releasing a device or gateway cancels tracked upstream work exactly once", () => {
    const connections = new RemoteConnections()
    const response = new PassThrough() as unknown as ServerResponse
    let cancelled = 0
    connections.track("device", response, () => {
      cancelled += 1
    })
    connections.closeDevice("device")
    expect(response.destroyed).toBe(true)
    expect(cancelled).toBe(1)

    const second = new PassThrough() as unknown as ServerResponse
    connections.track("other-device", second, () => {
      cancelled += 1
    })
    connections.closeAll()
    expect(second.destroyed).toBe(true)
    expect(cancelled).toBe(2)
  })

  test("revocation remains effective in memory when persistence fails", async () => {
    let failSave = false
    const persisted: RemoteAuthSnapshot[] = []
    const { gateway } = await fixture(() => {}, {
      saveAuth: async (snapshot) => {
        if (failSave) throw new Error("disk unavailable")
        persisted.push(snapshot)
      },
    })
    const paired = await pair(gateway.url, gateway)
    const deviceId = gateway.devices()[0].id
    failSave = true
    await expect(gateway.revoke(deviceId)).rejects.toBeDefined()
    const session = await fetch(`${gateway.url}/remote/api/session`, { headers: { Cookie: paired.cookie! } })
    expect(session.status).toBe(401)
    failSave = false
    await gateway.revoke(deviceId)
    expect(persisted.at(-1)?.devices).toEqual([])
    const restored = new RemoteAuth(async () => {}, persisted.at(-1))
    expect(restored.authenticate(paired.cookie!.split("=")[1])).toBeUndefined()
  })

  test("logout reports persistence failure and clears the locally revoked cookie", async () => {
    let failSave = false
    const { gateway } = await fixture(() => {}, {
      saveAuth: async () => {
        if (failSave) throw new Error("disk unavailable")
      },
    })
    const paired = await pair(gateway.url, gateway)
    const state = (await fetch(`${gateway.url}/remote/api/session`, { headers: { Cookie: paired.cookie! } }).then(
      (response) => response.json(),
    )) as { csrfToken: string }
    failSave = true
    const logout = await fetch(`${gateway.url}/remote/api/logout`, {
      method: "POST",
      headers: { Cookie: paired.cookie!, Origin: "https://remote.example", "x-opencode-csrf": state.csrfToken },
    })
    expect(logout.status).toBe(503)
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await fetch(`${gateway.url}/remote/api/session`, { headers: { Cookie: paired.cookie! } })).status).toBe(401)
  })

  test("serves the compiled shell only after authentication and gives assets a usable self-only CSP", async () => {
    const { gateway } = await fixture()
    const anonymousAsset = await fetch(`${gateway.url}/assets/app.123.js`)
    expect(anonymousAsset.status).toBe(200)
    expect(anonymousAsset.headers.get("content-security-policy")).toContain("script-src 'self'")
    const paired = await pair(gateway.url, gateway)
    const shell = await fetch(`${gateway.url}/`, { headers: { Cookie: paired.cookie!, Accept: "text/html" } })
    expect(shell.status).toBe(200)
    expect(shell.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(shell.headers.get("content-security-policy")).not.toContain("https:")
    expect(shell.headers.get("cache-control")).toBe("no-store")
  })

  test("serves only validated app deep links as authenticated SPA navigations", async () => {
    const { gateway } = await fixture()
    const directory = Buffer.from("/Users/test/project").toString("base64url")
    const paths = [
      "/",
      "/config",
      "/scheduled",
      `/${directory}`,
      `/${directory}/session`,
      `/${directory}/session/new/draft-1`,
      `/${directory}/session/session-1`,
      `/${directory}/config`,
      `/${directory}/scheduled`,
    ]
    expect(
      (await fetch(`${gateway.url}/${directory}/session/session-1`, { headers: { Accept: "text/html" } })).status,
    ).toBe(401)
    const paired = await pair(gateway.url, gateway)
    for (const path of paths) {
      const response = await fetch(`${gateway.url}${path}`, {
        headers: { Cookie: paired.cookie!, Accept: "text/html" },
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("remote client")
    }
    const invalidDirectory = Buffer.from("relative/path").toString("base64url")
    expect(
      (await fetch(`${gateway.url}/${invalidDirectory}`, { headers: { Cookie: paired.cookie!, Accept: "text/html" } }))
        .status,
    ).toBe(403)
    expect(
      (
        await fetch(`${gateway.url}/${directory}/session/session-1/unknown`, {
          headers: { Cookie: paired.cookie!, Accept: "text/html" },
        })
      ).status,
    ).toBe(403)
    expect((await fetch(`${gateway.url}/provider/auth`, { headers: { Accept: "text/html" } })).status).toBe(403)
  })

  test("returns unavailable cleanly on sidecar failure and closes idempotently", async () => {
    const { gateway } = await fixture(() => {}, { upstream: () => undefined })
    const paired = await pair(gateway.url, gateway)
    expect((await fetch(`${gateway.url}/project`, { headers: { Cookie: paired.cookie! } })).status).toBe(503)
    await Promise.all([gateway.close(), gateway.close()])
  })
})
