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

  test("release install and release-current update preserve their typed request selectors", async () => {
    const release = {
      ...preview,
      source: {
        type: "release" as const,
        descriptor: "https://example.com/releases/current",
        extensionID: id,
        version: "1.0.0",
        artifact: "https://cdn.example.com/test.tgz",
        sha256: "c".repeat(64),
        descriptorSha256: "d".repeat(64),
      },
      expectedRegistryVersion: 2,
      registryUpgrade: { from: 2 as const, to: 3 as const },
    }
    const seen: Parameters<InstallationService["prepare"]>[0][] = []
    adapter({
      async prepare(input) {
        seen.push(input)
        return { ...release, kind: input.kind }
      },
    })
    const install = { kind: "install", source: { type: "release", url: "https://example.com/releases/current" } }
    let response = await request("/global/extension/prepare", install)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      source: release.source,
      expectedRegistryVersion: 2,
      registryUpgrade: { from: 2, to: 3 },
    })
    expect(seen[0]).toEqual(install)
    const update = { kind: "update", id, target: "release-current" }
    response = await request("/global/extension/prepare", update)
    expect(response.status).toBe(200)
    expect(seen[1]).toEqual(update)
  })

  test("raw source, version and target selectors are mutually exclusive before installer access", async () => {
    adapter()
    const source = { type: "release", url: "https://example.com/releases/current" }
    for (const body of [
      { kind: "update", id, source, target: "release-current" },
      { kind: "update", id, version: "2.0.0", target: "release-current" },
      { kind: "update", id, source, version: "2.0.0", target: "release-current" },
      { kind: "update", id, source, target: null },
      { kind: "update", id },
      { kind: "install", source, target: "release-current" },
      { kind: "install", source, version: "2.0.0" },
      { kind: "uninstall", id, target: "release-current" },
      { kind: "uninstall", id, source },
    ]) {
      const response = await request("/global/extension/prepare", body)
      expect(response.status).toBe(400)
    }
    expect(calls).toBe(0)
  })

  test("install and update forward only explicit registry upgrade acceptance with the header capability", async () => {
    for (const kind of ["install", "update"] as const) {
      for (const acceptRegistryUpgrade of [undefined, false, true]) {
        const commits: Parameters<InstallationService["commit"]>[] = []
        adapter({
          async status() {
            return { ...preview, kind, state: "prepared", committed: false }
          },
          async commit(...args) {
            commits.push(args)
            return { ...result, kind }
          },
        })
        const response = await request(
          kind === "install" ? "/global/extension/install" : `/global/extension/${id}/update`,
          {
            operationId,
            ...(acceptRegistryUpgrade === undefined ? {} : { acceptRegistryUpgrade }),
            ...(kind === "install" ? { enable: true } : {}),
          },
        )
        expect(response.status).toBe(200)
        expect(commits).toHaveLength(1)
        expect(commits[0]?.slice(0, 2)).toEqual([operationId, token])
        expect(commits[0]?.[2]?.acceptRegistryUpgrade).toBe(acceptRegistryUpgrade)
        expect(commits[0]?.[2]?.enable).toBe(kind === "install" ? true : undefined)
      }
    }
  })

  test("uninstall rejects raw registry upgrade and enable fields rather than silently stripping them", async () => {
    adapter({
      async status() {
        calls++
        return { ...preview, kind: "uninstall", state: "prepared", committed: false }
      },
    })
    for (const options of [{ acceptRegistryUpgrade: true }, { acceptRegistryUpgrade: false }, { enable: false }]) {
      const response = await request(`/global/extension/${id}`, { operationId, ...options }, token, "DELETE")
      expect(response.status).toBe(400)
    }
    expect(calls).toBe(0)
    const response = await request(`/global/extension/${id}`, { operationId }, token, "DELETE")
    expect(response.status).toBe(200)
    expect(calls).toBe(2)
  })

  test("a confirmation cannot be used against a different action or extension", async () => {
    adapter()
    const response = await request(`/global/extension/${id}/update`, { operationId })
    expect(response.status).toBe(409)
    expect(calls).toBe(1)
    adapter({
      async status() {
        calls++
        return { ...preview, kind: "update", state: "prepared", committed: false }
      },
    })
    const wrongID = await request("/global/extension/test.other/update", { operationId, acceptRegistryUpgrade: true })
    expect(wrongID.status).toBe(409)
    expect(calls).toBe(2)
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
