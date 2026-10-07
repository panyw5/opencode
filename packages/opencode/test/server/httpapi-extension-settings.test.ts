import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import path from "path"
import { Extension } from "../../src/extension"
import { ExtensionRuntime } from "../../src/extension/runtime"
import { ExtensionPaths } from "../../src/server/routes/instance/httpapi/groups/extension"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { extensionPackage } from "../extension/fixture"

const context = Context.empty() as Context.Context<unknown>
const previous = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
let registry = ""

interface RequestInitLike {
  headers?: Record<string, string>
}

function request(pathname: string, init?: RequestInitLike & { method?: string; body?: string }) {
  return HttpApiApp.webHandler().handler(
    new Request(new URL(pathname, "http://localhost"), init as RequestInit),
    context,
  )
}

function authenticatedApp(password: string) {
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "opencode" }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return (pathname: string, init?: RequestInitLike & { method?: string; body?: string }) =>
    handler(new Request(new URL(pathname, "http://localhost"), init as RequestInit), context)
}

function settingsPath(id: string) {
  return ExtensionPaths.settings.replace(":id", id)
}

function patch(pathname: string, body: unknown, init?: RequestInitLike) {
  return request(pathname, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  })
}

async function settingsExtension(dir: string) {
  const root = await extensionPackage(dir)
  const file = path.join(root, "package.json")
  const pkg = (await Bun.file(file).json()) as {
    opencode: { contributes: Record<string, unknown> }
  }
  pkg.opencode.contributes.settings = {
    endpoint: { type: "string", title: "Endpoint", default: "https://example.com" },
    retries: { type: "number", title: "Retries", default: 3 },
    verbose: { type: "boolean", title: "Verbose", default: false },
    mode: { type: "string", title: "Mode", enum: ["fast", "slow"], default: "fast" },
    apiKey: { type: "string", title: "API key", secret: true },
  }
  await Bun.write(file, JSON.stringify(pkg, null, 2))
  return root
}

async function service() {
  return import("effect").then(({ Effect }) =>
    Effect.runPromise(Extension.Service.pipe(Effect.provide(Extension.defaultLayer))),
  )
}

async function storedSettings(): Promise<Record<string, Record<string, unknown>>> {
  const store = (await Bun.file(registry).json()) as {
    extensions: Record<string, { settings?: Record<string, unknown> }>
  }
  return Object.fromEntries(Object.entries(store.extensions).map(([id, row]) => [id, row.settings ?? {}]))
}

const notified: Array<{ id: string; settings: Record<string, unknown> }> = []
const originalNotify = ExtensionRuntime.notifySettings

beforeEach(async () => {
  const dir = await import("fs/promises").then((fs) =>
    fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-settings-")),
  )
  registry = path.join(dir, "registry.json")
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
  notified.length = 0
  ExtensionRuntime.notifySettings = (id, settings) => {
    notified.push({ id, settings })
  }
})

afterEach(async () => {
  ExtensionRuntime.notifySettings = originalNotify
  await disposeAllInstances()
  await resetDatabase()
  if (previous === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previous
  await import("fs/promises").then((fs) => fs.rm(path.dirname(registry), { recursive: true, force: true }))
})

describe("extension settings HttpApi", () => {
  test("applies a valid patch, persists it and notifies the runtime with real values", async () => {
    await using tmp = await tmpdir()
    const root = await settingsExtension(tmp.path)
    const ext = await service()
    await import("effect").then(({ Effect }) => Effect.runPromise(ext.link(root)))

    const response = await patch(settingsPath("test.extension"), {
      endpoint: "https://api.test",
      retries: 5,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { settings: Record<string, unknown> }
    expect(body.settings).toEqual({ endpoint: "https://api.test", retries: 5, verbose: false, mode: "fast" })

    const detail = await request(ExtensionPaths.get.replace(":id", "test.extension"))
    expect(detail.status).toBe(200)
    expect(((await detail.json()) as { settings: Record<string, unknown> }).settings).toMatchObject({
      endpoint: "https://api.test",
      retries: 5,
    })

    // The runtime is notified with the real (unmasked) resolved settings.
    expect(notified).toHaveLength(1)
    expect(notified[0]?.id).toBe("test.extension")
    expect(notified[0]?.settings).toMatchObject({
      endpoint: "https://api.test",
      retries: 5,
      verbose: false,
      mode: "fast",
    })
    expect(notified[0]?.settings.apiKey).toBeUndefined()
  })

  test("rejects unknown keys, wrong types and enum violations with 400", async () => {
    await using tmp = await tmpdir()
    const root = await settingsExtension(tmp.path)
    const ext = await service()
    await import("effect").then(({ Effect }) => Effect.runPromise(ext.link(root)))

    const responses = await Promise.all([
      patch(settingsPath("test.extension"), { unknown: "value" }),
      patch(settingsPath("test.extension"), { retries: "five" }),
      patch(settingsPath("test.extension"), { mode: "medium" }),
      patch(settingsPath("test.extension"), { verbose: "yes" }),
    ])
    for (const response of responses) expect(response.status).toBe(400)

    // The failed patches must not have touched stored settings.
    expect(await storedSettings()).toEqual({ "test.extension": {} })
  })

  test("returns 404 for an unknown extension", async () => {
    const response = await patch(settingsPath("test.missing"), { endpoint: "x" })
    expect(response.status).toBe(404)
  })

  test("masks secret values in responses while storing plaintext, and the mask round-trips", async () => {
    await using tmp = await tmpdir()
    const root = await settingsExtension(tmp.path)
    const ext = await service()
    await import("effect").then(({ Effect }) => Effect.runPromise(ext.link(root)))

    const update = await patch(settingsPath("test.extension"), { apiKey: "super-secret" })
    expect(update.status).toBe(200)
    const body = (await update.json()) as { settings: Record<string, unknown> }
    expect(body.settings.apiKey).toBe("********")

    const detail = await request(ExtensionPaths.get.replace(":id", "test.extension"))
    expect(((await detail.json()) as { settings: Record<string, unknown> }).settings.apiKey).toBe("********")

    // The registry file keeps the plaintext value.
    expect((await storedSettings())["test.extension"].apiKey).toBe("super-secret")

    // Submitting the mask back keeps the stored value.
    const keep = await patch(settingsPath("test.extension"), { apiKey: "********" })
    expect(keep.status).toBe(200)
    expect((await storedSettings())["test.extension"].apiKey).toBe("super-secret")
  })

  test("resets a setting back to its manifest default with an explicit null", async () => {
    await using tmp = await tmpdir()
    const root = await settingsExtension(tmp.path)
    const ext = await service()
    await import("effect").then(({ Effect }) => Effect.runPromise(ext.link(root)))

    await patch(settingsPath("test.extension"), { endpoint: "https://api.test" })
    const reset = await patch(settingsPath("test.extension"), { endpoint: null })
    expect(reset.status).toBe(200)
    const body = (await reset.json()) as { settings: Record<string, unknown> }
    expect(body.settings.endpoint).toBe("https://example.com")
    expect((await storedSettings())["test.extension"].endpoint).toBeUndefined()
  })

  test("requires authentication when a server password is configured", async () => {
    await using tmp = await tmpdir()
    const root = await settingsExtension(tmp.path)
    const ext = await service()
    await import("effect").then(({ Effect }) => Effect.runPromise(ext.link(root)))
    const server = authenticatedApp("secret")
    const call = (init?: RequestInitLike) =>
      server(settingsPath("test.extension"), {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        body: JSON.stringify({ endpoint: "https://api.test" }),
      })

    const denied = await call()
    expect(denied.status).toBe(401)

    const allowed = await call({
      headers: { Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}` },
    })
    expect(allowed.status).toBe(200)
  })
})
