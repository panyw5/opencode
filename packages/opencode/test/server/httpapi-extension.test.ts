import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdir, symlink } from "fs/promises"
import path from "path"
import { Extension } from "../../src/extension"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionPaths } from "../../src/server/routes/instance/httpapi/groups/extension"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { extensionPackage } from "../extension/fixture"

const context = Context.empty() as Context.Context<unknown>
const previous = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
let registry = ""

function request(pathname: string, init?: RequestInit) {
  return HttpApiApp.webHandler().handler(new Request(new URL(pathname, "http://localhost"), init), context)
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
  return (pathname: string, init?: RequestInit) =>
    handler(new Request(new URL(pathname, "http://localhost"), init), context)
}

beforeEach(async () => {
  const dir = await import("fs/promises").then((fs) => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-http-")))
  registry = path.join(dir, "registry.json")
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  if (previous === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previous
  await import("fs/promises").then((fs) => fs.rm(path.dirname(registry), { recursive: true, force: true }))
})

describe("extension HttpApi", () => {
  test("lists, reads, disables and enables linked extensions", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path)
    const service = await import("effect").then(({ Effect }) =>
      Effect.runPromise(Extension.Service.pipe(Effect.provide(Extension.defaultLayer))),
    )
    await import("effect").then(({ Effect }) => Effect.runPromise(service.link(root)))

    const listed = await request(ExtensionPaths.list)
    expect(listed.status).toBe(200)
    const [item] = (await listed.json()) as Array<{ id: string; state: string; web?: { base: string } }>
    expect(item?.id).toBe("test.extension")
    expect(item?.state).toBe("ready")
    expect(item?.web?.base).toContain(`/extension-asset/${service.token}/`)

    const detail = await request(ExtensionPaths.get.replace(":id", "test.extension"))
    expect(detail.status).toBe(200)
    expect((await detail.json()).id).toBe("test.extension")

    const disabled = await request(ExtensionPaths.disable.replace(":id", "test.extension"), { method: "POST" })
    expect(disabled.status).toBe(200)
    expect((await disabled.json()).state).toBe("disabled")

    const enabled = await request(ExtensionPaths.enable.replace(":id", "test.extension"), { method: "POST" })
    expect(enabled.status).toBe(200)
    expect((await enabled.json()).state).toBe("ready")
  })

  test("returns 404 for an unknown extension", async () => {
    const response = await request(ExtensionPaths.get.replace(":id", "test.missing"))
    expect(response.status).toBe(404)
  })
})

describe("extension asset route", () => {
  test("serves enabled assets ahead of the UI fallback", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path, { styles: ["dist/web/index.css"] })
    await Bun.write(path.join(root, "dist/web/index.js"), "export default 'asset'\n")
    const item = await ExtensionRegistry.link(root, (manifest) =>
      `/extension-asset/${Extension.assetToken()}/${manifest.id}/${manifest.versionSegment}/`,
    )
    const base = item.web?.base
    expect(base).toBeDefined()

    const response = await request(`${base}index.js`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("export default 'asset'\n")
    expect(response.headers.get("content-type")).toContain("javascript")
    expect(response.headers.get("cache-control")).toBe("no-cache")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("uses a capability token under Basic auth and emits renderer CORS headers", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path)
    const item = await ExtensionRegistry.link(root, (manifest) =>
      `/extension-asset/${Extension.assetToken()}/${manifest.id}/${manifest.versionSegment}/`,
    )
    const server = authenticatedApp("secret")

    const allowed = await server(`${item.web!.base}index.js`, { headers: { origin: "oc://renderer" } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get("access-control-allow-origin")).toBe("oc://renderer")

    const denied = await server(`${item.web!.base.replace(Extension.assetToken(), "wrong-token")}index.js`)
    expect(denied.status).toBe(404)

    const wrongMethod = await server(`${item.web!.base}index.js`, { method: "POST" })
    expect(wrongMethod.status).toBe(404)
  })

  test("rejects unknown versions, traversal, symlinks, directories, and HTML", async () => {
    await using tmp = await tmpdir()
    await using outside = await tmpdir()
    const root = await extensionPackage(tmp.path)
    await Bun.write(path.join(root, "dist/web/page.html"), "<script>bad()</script>")
    await Bun.write(path.join(outside.path, "secret.js"), "secret")
    await symlink(path.join(outside.path, "secret.js"), path.join(root, "dist/web/escape.js"))
    await mkdir(path.join(root, "dist/web/dir"), { recursive: true })
    const item = await ExtensionRegistry.link(root, (manifest) =>
      `/extension-asset/${Extension.assetToken()}/${manifest.id}/${manifest.versionSegment}/`,
    )
    const base = item.web!.base
    const wrongVersion = base.replace(/\/[^/]+\/$/, "/wrong/")

    const responses = await Promise.all([
      request(`${wrongVersion}index.js`),
      request(`${base}%2e%2e%2fpackage.json`),
      request(`${base}%252e%252e%252fpackage.json`),
      request(`${base}escape.js`),
      request(`${base}dir`),
      request(`${base}page.html`),
    ])

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404])
    for (const response of responses) expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("stops serving assets as soon as the extension is disabled", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path)
    const item = await ExtensionRegistry.link(root, (manifest) =>
      `/extension-asset/${Extension.assetToken()}/${manifest.id}/${manifest.versionSegment}/`,
    )
    await ExtensionRegistry.setEnabled(item.id, false)
    const response = await request(`${item.web!.base}index.js`)
    expect(response.status).toBe(404)
  })
})
