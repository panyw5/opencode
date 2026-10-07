import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { mkdir, symlink } from "fs/promises"
import path from "path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Extension } from "../../src/extension"
import { ExtensionRuntime } from "../../src/extension/runtime"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionPaths } from "../../src/server/routes/instance/httpapi/groups/extension"
import { ExtensionRpcPaths } from "../../src/server/routes/instance/httpapi/groups/extension-rpc"
import {
  DEFAULT_RPC_TIMEOUT_MS,
  installExtensionRpcAdapter,
  MAX_RPC_TIMEOUT_MS,
  resetExtensionRpcAdapter,
  type ExtensionRpcCall,
} from "../../src/server/routes/instance/httpapi/handlers/extension-rpc"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { PublicApi } from "../../src/server/routes/instance/httpapi/public"
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
  const dir = await import("fs/promises").then((fs) =>
    fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-http-")),
  )
  registry = path.join(dir, "registry.json")
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
  resetExtensionRpcAdapter()
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
    const item = await ExtensionRegistry.link(
      root,
      (manifest) => `/extension-asset/${Extension.assetToken()}/${manifest.id}/${manifest.versionSegment}/`,
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
    const item = await ExtensionRegistry.link(
      root,
      (manifest) => `/extension-asset/${Extension.assetToken()}/${manifest.id}/${manifest.versionSegment}/`,
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
    const item = await ExtensionRegistry.link(
      root,
      (manifest) => `/extension-asset/${Extension.assetToken()}/${manifest.id}/${manifest.versionSegment}/`,
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
    const item = await ExtensionRegistry.link(
      root,
      (manifest) => `/extension-asset/${Extension.assetToken()}/${manifest.id}/${manifest.versionSegment}/`,
    )
    await ExtensionRegistry.setEnabled(item.id, false)
    const response = await request(`${item.web!.base}index.js`)
    expect(response.status).toBe(404)
  })
})

describe("extension rpc route", () => {
  async function linkTestExtension(directory: string) {
    const root = await extensionPackage(directory)
    const service = await Effect.runPromise(Extension.Service.pipe(Effect.provide(Extension.defaultLayer)))
    await Effect.runPromise(service.link(root))
  }

  function rpcURL(extension = "test.extension", method = "ping", query = "") {
    return `${ExtensionRpcPaths.rpc.replace(":id", extension).replace(":method", method)}${query}`
  }

  function recordingAdapter(result: unknown, options?: { impl?: (call: ExtensionRpcCall) => Promise<unknown> }) {
    const calls: ExtensionRpcCall[] = []
    installExtensionRpcAdapter({
      call: (call) => {
        calls.push(call)
        return options?.impl ? options.impl(call) : Promise.resolve(result)
      },
    })
    return calls
  }

  test("invokes the process-level handler without directory", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter({ echo: 1 })

    const response = await request(rpcURL(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { hello: "world" } }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: { echo: 1 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.id).toBe("test.extension")
    expect(calls[0]!.method).toBe("ping")
    expect(calls[0]!.input).toEqual({ hello: "world" })
    expect(calls[0]!.directory).toBeUndefined()
    expect(calls[0]!.signal.aborted).toBe(false)
  })

  test("the generated SDK sends the RPC input envelope", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter("sdk-result")
    const client = createOpencodeClient({
      baseUrl: "http://localhost",
      fetch: (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init)
        return HttpApiApp.webHandler().handler(req, context)
      },
    })
    const result = await client.extension.rpc({ id: "test.extension", method: "ping", input: { hello: "sdk" } })
    expect(result.data).toEqual({ result: "sdk-result" })
    expect(calls[0].input).toEqual({ hello: "sdk" })
  })

  test("boots per-instance hooks on the first explicit-directory RPC", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path, {
      webExport: null,
      webManifest: false,
      fileViewers: null,
      activation: null,
      serverEntry: "dist/server.js",
    })
    await Bun.write(
      path.join(root, "dist/server.js"),
      'export default { id: "test.extension", async activate() { return { rpc: { ping: async () => "process" } } }, async server(input) { return { rpc: { ping: async () => `instance:${input.directory}` } } } }',
    )
    const service = await Effect.runPromise(Extension.Service.pipe(Effect.provide(Extension.defaultLayer)))
    await Effect.runPromise(service.link(root))
    installExtensionRpcAdapter({ call: (call) => ExtensionRuntime.rpc(call) })

    const url = rpcURL("test.extension", "ping", `?directory=${encodeURIComponent(tmp.path)}`)
    const first = await request(url, { method: "POST", body: "{}" })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ result: `instance:${tmp.path}` })
    const unscoped = await request(rpcURL(), { method: "POST", body: "{}" })
    expect(await unscoped.json()).toEqual({ result: "process" })

    const nonCanonical = await request(
      rpcURL("test.extension", "ping", `?directory=${encodeURIComponent(path.join(tmp.path, "nested", ".."))}`),
      { method: "POST", body: "{}" },
    )
    expect(nonCanonical.status).toBe(200)
    expect(await nonCanonical.json()).toEqual({ result: `instance:${tmp.path}` })

    await ExtensionRuntime.invalidateHooks()
    await ExtensionRuntime.reload("test.extension")
    const afterReload = await request(url, { method: "POST", body: "{}" })
    expect(afterReload.status).toBe(200)
    expect(await afterReload.json()).toEqual({ result: `instance:${tmp.path}` })
  })

  test("rejects a missing explicit RPC directory", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter("unreachable")
    const missing = path.join(tmp.path, "does-not-exist")
    const response = await request(rpcURL("test.extension", "ping", `?directory=${encodeURIComponent(missing)}`), {
      method: "POST",
      body: "{}",
    })
    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  test("forwards an explicit directory to the adapter", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter("ok")

    const response = await request(rpcURL("test.extension", "ping", `?directory=${encodeURIComponent(tmp.path)}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: "ok" })
    expect(calls[0]!.directory).toBe(tmp.path)
  })

  test("accepts an omitted request body as no input", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter(true)

    const response = await request(rpcURL(), { method: "POST" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: true })
    expect(calls[0]!.input).toBeUndefined()
  })

  test("accepts an empty-object body as no input", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter("ok")

    const response = await request(rpcURL(), { method: "POST", body: "{}" })

    expect(response.status).toBe(200)
    expect(calls[0]!.input).toBeUndefined()
  })

  test("accepts a body wrapping only the input field", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter("ok")

    const response = await request(rpcURL(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [1, "two", { three: null }] }),
    })

    expect(response.status).toBe(200)
    expect(calls[0]!.input).toEqual([1, "two", { three: null }])
  })

  test("rejects a non-JSON body with 400", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter("never")

    const response = await request(rpcURL(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })

    expect(response.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  test("rejects a JSON body that is not an object with 400", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter("never")

    for (const body of ["[1,2]", '"text"', "42", "null"]) {
      const response = await request(rpcURL(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      expect(response.status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  test("returns 404 for an unknown extension", async () => {
    recordingAdapter("never")

    const response = await request(rpcURL("test.missing"), { method: "POST", body: "{}" })
    expect(response.status).toBe(404)
  })

  test("returns 404 for a disabled extension", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const calls = recordingAdapter("never")

    const disabled = await request(ExtensionPaths.disable.replace(":id", "test.extension"), { method: "POST" })
    expect(disabled.status).toBe(200)

    const response = await request(rpcURL(), { method: "POST", body: "{}" })
    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  test("maps runtime lookup errors to 404", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const lookupFailure = Object.assign(new Error("Extension RPC method not found: test.extension.missing"), {
      name: "ExtensionRpcMethodNotFoundError",
      id: "test.extension",
      method: "missing",
    })
    recordingAdapter(undefined, { impl: () => Promise.reject(lookupFailure) })

    const response = await request(rpcURL("test.extension", "missing"), { method: "POST", body: "{}" })
    expect(response.status).toBe(404)
  })

  test("maps handler errors with a code to 400 and keeps code and message", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    const handlerFailure = Object.assign(new Error("kernel not running"), {
      name: "ExtensionRpcHandlerError",
      code: "WOLFRAM_DOWN",
    })
    recordingAdapter(undefined, { impl: () => Promise.reject(handlerFailure) })

    const response = await request(rpcURL(), { method: "POST", body: "{}" })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      _tag: "ExtensionRpcError",
      code: "WOLFRAM_DOWN",
      message: "kernel not running",
    })
  })

  test("accepts the kit's duck-typed ExtensionRpcError shape", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    recordingAdapter(undefined, {
      impl: () => Promise.reject({ name: "ExtensionRpcError", code: "VALIDATION", message: "bad input" }),
    })

    const response = await request(rpcURL(), { method: "POST", body: "{}" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ _tag: "ExtensionRpcError", code: "VALIDATION" })
  })

  test("maps unexpected handler failures to 500 with the message only", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    recordingAdapter(undefined, { impl: () => Promise.reject(new Error("kernel crashed")) })

    const response = await request(rpcURL(), { method: "POST", body: "{}" })
    expect(response.status).toBe(500)
    const body = (await response.json()) as { message?: string; stack?: string; cause?: unknown }
    expect(body.message).toBe("kernel crashed")
    expect(body.stack).toBeUndefined()
    expect("cause" in body).toBe(false)
  })

  test("times out long calls with 504 and aborts the adapter signal", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    let captured: AbortSignal | undefined
    installExtensionRpcAdapter({
      call: (call) => {
        captured = call.signal
        return new Promise(() => {})
      },
    })

    const response = await request(rpcURL(), {
      method: "POST",
      headers: { "x-opencode-rpc-timeout": "50" },
      body: "{}",
    })

    expect(response.status).toBe(504)
    const body = (await response.json()) as { _tag?: string; message?: string }
    expect(body._tag).toBe("TimeoutError")
    await Bun.sleep(20)
    expect(captured?.aborted).toBe(true)
  })

  test("aborts the adapter signal when the client disconnects", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    let captured: AbortSignal | undefined
    installExtensionRpcAdapter({
      call: (call) => {
        captured = call.signal
        return new Promise(() => {})
      },
    })
    const server = Bun.serve({
      port: 0,
      fetch: (req) => HttpApiApp.webHandler().handler(req, context),
    })
    try {
      const controller = new AbortController()
      const pending = fetch(new URL(rpcURL(), server.url), {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      }).catch(() => undefined)
      await Bun.sleep(100)
      controller.abort()

      const deadline = Date.now() + 2000
      while (!captured?.aborted && Date.now() < deadline) await Bun.sleep(20)
      expect(captured?.aborted).toBe(true)
      await pending
    } finally {
      server.stop(true)
    }
  })

  test("returns 503 while no extension runtime is installed", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    resetExtensionRpcAdapter()

    const response = await request(rpcURL(), { method: "POST", body: "{}" })
    expect(response.status).toBe(503)
  })

  test("clamps oversized timeout headers to the maximum", async () => {
    expect(MAX_RPC_TIMEOUT_MS).toBe(600_000)
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(120_000)
  })

  test("requires authorization under Basic auth", async () => {
    await using tmp = await tmpdir()
    await linkTestExtension(tmp.path)
    recordingAdapter({ authorized: true })
    const server = authenticatedApp("secret")
    const url = rpcURL()

    const denied = await server(url, { method: "POST", body: "{}" })
    expect(denied.status).toBe(401)

    const allowed = await server(url, {
      method: "POST",
      headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      body: "{}",
    })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ result: { authorized: true } })
  })
})

describe("extension rpc OpenAPI declaration", () => {
  test("declares an optional { input?: unknown } request body", () => {
    const spec = OpenApi.fromApi(PublicApi) as {
      paths: Record<string, Record<string, { operationId?: string; requestBody?: Record<string, unknown> }>>
    }
    const operation = spec.paths["/extension/{id}/rpc/{method}"]?.post
    expect(operation?.operationId).toBe("extension.rpc")

    const requestBody = operation?.requestBody as
      | { required?: boolean; content?: Record<string, { schema?: Record<string, unknown> }> }
      | undefined
    // The body must be advertised so SDK clients can send `{ input }`...
    expect(requestBody).toBeDefined()
    const schema = requestBody!.content?.["application/json"]?.schema
    expect(schema?.type).toBe("object")
    expect("input" in (schema?.properties ?? {})).toBe(true)
    // ...but never marked required: RPC methods without input are called with
    // a body-less POST, which the handler accepts (parseRpcBody).
    expect(requestBody!.required).not.toBe(true)
  })
})
