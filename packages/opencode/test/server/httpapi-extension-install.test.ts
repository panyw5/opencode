import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Layer } from "effect"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import {
  installExtensionInstallAdapter,
  resetExtensionInstallAdapter,
} from "../../src/server/routes/instance/httpapi/handlers/extension-install"
import { InstallError, type InstallPreview, type InstallResult } from "../../src/extension/install"
import type { InstallationService } from "../../src/extension/install-service"
import { ExtensionID } from "../../src/extension/schema"

const operationId = "00000000-0000-4000-8000-000000000001"
const token = `${"a".repeat(64)}.${"b".repeat(64)}`
const id = ExtensionID.make("test.install-http")
const preview: InstallPreview & { token: string } = {
  operationId,
  token,
  expiresAt: Date.now() + 60000,
  kind: "install",
  id,
  name: "test-install-http",
  version: "1.0.0",
  permissions: [],
  permissionsAdded: [],
  permissionsRemoved: [],
  contributes: {},
  source: { type: "archive", location: "https://example.com/test.tgz", sha256: "c".repeat(64) },
  hasServer: true,
  enable: false,
}
const result: InstallResult = {
  operationId,
  kind: "install",
  id,
  state: "committed",
  committed: true,
  synced: false,
  cleanupPending: true,
  warnings: ["Runtime synchronization pending"],
}
let calls = 0
function adapter(overrides: Partial<InstallationService> = {}) {
  installExtensionInstallAdapter({
    async prepare() {
      calls++
      return preview
    },
    async status() {
      calls++
      return { ...preview, state: "prepared", committed: false }
    },
    async commit() {
      calls++
      return result
    },
    async cancel() {
      calls++
      return { ...result, state: "cancelled", committed: false }
    },
    ...overrides,
  })
}
afterEach(() => {
  calls = 0
  resetExtensionInstallAdapter()
})
const context = Context.empty() as Context.Context<unknown>
const request = (pathname: string, body?: unknown, capability = token, method = "POST") =>
  HttpApiApp.webHandler().handler(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: { "content-type": "application/json", "x-opencode-extension-token": capability },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    context,
  )

describe("extension installation HTTP", () => {
  test("prepare returns a typed preview and commit uses header capability", async () => {
    adapter()
    const prepared = await request("/global/extension/prepare", {
      kind: "install",
      source: { type: "npm", spec: "example@1.0.0" },
    })
    expect(prepared.status).toBe(200)
    expect((await prepared.json()).token).toBe(token)
    const committed = await request("/global/extension/install", { operationId })
    expect(committed.status).toBe(200)
    expect(await committed.json()).toMatchObject({ committed: true, synced: false, cleanupPending: true })
    expect(calls).toBe(3)
  })

  test("HTTP rejects local paths without reaching the installer", async () => {
    adapter()
    const response = await request("/global/extension/prepare", {
      kind: "install",
      source: { type: "local", path: "/tmp/private.tgz", sha256: "c".repeat(64) },
    })
    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })

  test("a source and version cannot both select an update", async () => {
    adapter()
    const response = await request("/global/extension/prepare", {
      kind: "update",
      id,
      source: { type: "npm", spec: "example@2.0.0" },
      version: "3.0.0",
    })
    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })

  test("a confirmation cannot be used against a different action or extension", async () => {
    adapter()
    const response = await request(`/global/extension/${id}/update`, { operationId })
    expect(response.status).toBe(409)
    expect(calls).toBe(1)
  })

  test("capability is required in a header, never a body token", async () => {
    adapter()
    const response = await request("/global/extension/install", { operationId, token }, "")
    expect(response.status).toBe(400)
    expect(calls).toBe(0)
  })

  test("errors never return source credentials or raw exception details", async () => {
    adapter({
      async prepare() {
        throw new Error("private-token https://user:password@example.com/?secret")
      },
    })
    const response = await request("/global/extension/prepare", {
      kind: "install",
      source: { type: "npm", spec: "example" },
    })
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).not.toContain("password")
    expect(text).not.toContain("private-token")
  })

  test("expired confirmation maps to gone without exposing its token", async () => {
    adapter({
      async status() {
        throw new InstallError("expired", token)
      },
    })
    const response = await request(`/global/extension/operation/${operationId}`, undefined, token, "GET")
    expect(response.status).toBe(410)
    expect(await response.text()).not.toContain(token)
  })

  test("generated SDK carries the confirmation header and JSON operation envelope", async () => {
    adapter()
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        HttpApiApp.webHandler().handler(
          input instanceof Request ? input : new Request(input, init),
          context,
        )) as typeof fetch,
    })
    const prepared = await client.extensionInstallation.prepare({
      extensionPrepareInput: { kind: "install", source: { type: "npm", spec: "example" } },
    })
    expect(prepared.data?.operationId).toBe(operationId)
    const committed = await client.extensionInstallation.install({ operationId, "x-opencode-extension-token": token })
    expect(committed.data?.committed).toBe(true)
    expect(calls).toBe(3)
  })

  test("pure mode blocks all installation endpoints before touching the adapter", async () => {
    adapter()
    const handler = HttpRouter.toWebHandler(
      HttpApiApp.createRoutes().pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_PURE: true }))),
      ),
      { disableLogger: true },
    ).handler
    const response = await handler(
      new Request("http://localhost/global/extension/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "install", source: { type: "npm", spec: "example" } }),
      }),
      context,
    )
    expect(response.status).toBe(403)
    expect(calls).toBe(0)
  })

  test("server authentication precedes installation work", async () => {
    adapter()
    const handler = HttpRouter.toWebHandler(
      HttpApiApp.routes.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: "private", OPENCODE_SERVER_USERNAME: "opencode" }),
          ),
        ),
      ),
      { disableLogger: true },
    ).handler
    const response = await handler(
      new Request("http://localhost/global/extension/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "install", source: { type: "npm", spec: "example" } }),
      }),
      context,
    )
    expect(response.status).toBe(401)
    expect(calls).toBe(0)
  })
})
