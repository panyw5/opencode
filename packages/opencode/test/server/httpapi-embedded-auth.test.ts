import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { EmbeddedWebUI } from "../../src/server/shared/ui"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "embedded-auth-"))
const manifest: Record<string, string> = {}
for (const [name, body] of Object.entries({
  "index.html": "<html><body>private shell</body></html>",
  "assets/app.js": "console.log('public bundle')",
  "assets/app.css": "body { color: black }",
  "assets/font.woff2": "font",
  "assets/icon.svg": "<svg/>",
  "assets/sound.aac": "audio",
  "assets/parser.wasm": "wasm",
  "assets/app.js.map": "source map",
  "config.json": "{}",
  _headers: "private metadata",
  "session/protected.js": "never bypass a matched API",
})) {
  const target = path.join(root, name.replaceAll("/", "-"))
  await writeFile(target, body)
  manifest[name] = target
}
manifest["assets/disguised.js"] = manifest["index.html"]

const apps: Array<ReturnType<typeof HttpRouter.toWebHandler>> = []
function app(embedded: Record<string, string> | null, disable = false) {
  const routes = HttpApiApp.createRoutes(
    undefined,
    Layer.succeed(EmbeddedWebUI)({ manifest: Effect.succeed(embedded) }),
  )
  const server = HttpRouter.toWebHandler(
    routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: "se?cr~et:tail",
            OPENCODE_SERVER_USERNAME: "opencode",
            OPENCODE_DISABLE_EMBEDDED_WEB_UI: disable,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  )
  apps.push(server)
  return (url: string, init?: RequestInit) =>
    server.handler(new Request(`http://localhost${url}`, init), Context.empty() as Context.Context<unknown>)
}
const request = app(manifest)
const token = Buffer.from("opencode:se?cr~et:tail").toString("base64url")

afterAll(async () => {
  await Promise.all(apps.map((app) => app.dispose()))
  await rm(root, { recursive: true, force: true })
})

describe("embedded UI authentication boundary", () => {
  test("allows exact static build assets without credentials", async () => {
    for (const file of ["app.js", "app.css", "font.woff2", "icon.svg", "sound.aac", "parser.wasm"]) {
      const response = await request(`/assets/${file}`)
      expect(response.status).toBe(200)
      expect(await response.text()).not.toContain("private shell")
    }
  })

  test("authorizes the document using an unpadded URL token then loads assets without it", async () => {
    const html = await request(`/?auth_token=${token}`)
    expect(html.status).toBe(200)
    expect(await html.text()).toContain("private shell")
    expect(html.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect((await request("/assets/app.js")).status).toBe(200)
    expect((await request("/global/health")).status).toBe(401)
  })

  test("does not expose HTML, fallback routes or build metadata", async () => {
    for (const pathname of [
      "/",
      "/index.html",
      "/assets/unknown.js",
      "/assets/app.js.map",
      "/config.json",
      "/_headers",
      "/assets/disguised.js",
      "/constructor",
      "/assets/%61pp.js",
    ]) {
      expect((await request(pathname)).status).toBe(401)
    }
    for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
      expect((await request("/assets/app.js", { method })).status).toBe(401)
    }
  })

  test("keeps matched API, file, RPC and event routes protected", async () => {
    for (const pathname of [
      "/global/health",
      "/global/event",
      "/global/extension",
      "/session/protected.js",
      "/file/raw?path=anything",
      "/event",
      "/doc",
    ]) {
      expect((await request(pathname)).status).toBe(401)
    }
    expect((await request("/extension/test.demo/rpc/ping", { method: "POST", body: "{}" })).status).toBe(401)
    expect((await request("/extension-asset/wrong/test.demo/1.0/index.js")).status).toBe(404)
  })

  test("missing public PWA assets do not fall back to the authenticated HTML", async () => {
    for (const pathname of ["/site.webmanifest", "/web-app-manifest-192x192.png", "/web-app-manifest-512x512.png"]) {
      const response = await request(pathname)
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain("private shell")
    }
  })

  test("does not enable the exemption in proxy or disabled-embedded mode", async () => {
    const proxy = app(null)
    const disabled = app(manifest, true)
    expect((await proxy("/assets/app.js")).status).toBe(401)
    expect((await disabled("/assets/app.js")).status).toBe(401)
  })
})
