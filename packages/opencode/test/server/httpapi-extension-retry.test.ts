import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Context } from "effect"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionRuntime } from "../../src/extension/runtime"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { extensionPackage } from "../extension/fixture"

const previous = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
let registry = ""
const context = Context.empty() as Context.Context<unknown>

function request(url: string, method = "GET") {
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${url}`, { method }), context)
}

beforeEach(async () => {
  registry = path.join(await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-retry-")), "registry.json")
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
})

afterEach(async () => {
  await disposeAllInstances()
  await ExtensionRuntime.testing.reset()
  if (previous === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previous
  await rm(path.dirname(registry), { recursive: true, force: true })
})

test("runtime errors remain visible without disabling healthy web contributions", async () => {
  await using tmp = await tmpdir()
  const root = await extensionPackage(tmp.path, { serverEntry: "dist/server.js" })
  await Bun.write(
    path.join(root, "dist/server.js"),
    'export default { activate() { throw new Error("broken activation") } }',
  )
  const item = await ExtensionRegistry.link(root)
  const detailURL = `/global/extension/${item.id}`
  const idle = await request(detailURL)
  expect((await idle.json()).server).toEqual({
    hasService: false,
    hasInstanceHooks: false,
    runtime: "idle",
    needsRestart: false,
  })
  await ExtensionRuntime.rpc({ id: item.id, method: "ping" }).catch(() => undefined)
  const failed = await request(detailURL)
  const info = await failed.json()
  expect(info.state).toBe("ready")
  expect(info.web).toBeDefined()
  expect(info.server.runtime).toBe("error")
  expect(info.server.error).toContain("broken activation")
  expect(info.server.needsRestart).toBe(false)
})

test("retry clears a sticky error and invalidates hook caches", async () => {
  await using tmp = await tmpdir()
  const root = await extensionPackage(tmp.path, { serverEntry: "dist/server.js" })
  await Bun.write(path.join(root, "dist/server.js"), 'export default { activate() { throw new Error("retry me") } }')
  const item = await ExtensionRegistry.link(root)
  await ExtensionRuntime.rpc({ id: item.id, method: "ping" }).catch(() => undefined)
  let invalidations = 0
  const unregister = ExtensionRuntime.registerCacheInvalidator("plugin", async () => {
    invalidations++
  })
  try {
    const retried = await request(`/global/extension/${item.id}/retry`, "POST")
    expect(retried.status).toBe(200)
    expect((await retried.json()).server.runtime).toBe("idle")
    expect(invalidations).toBeGreaterThan(0)
  } finally {
    unregister()
  }
})

test("generated SDK invokes the retry endpoint and preserves runtime metadata", async () => {
  await using tmp = await tmpdir()
  const root = await extensionPackage(tmp.path)
  const item = await ExtensionRegistry.link(root)
  const client = createOpencodeClient({
    baseUrl: "http://localhost",
    fetch: (input, init) =>
      HttpApiApp.webHandler().handler(input instanceof Request ? input : new Request(input, init), context),
  })
  const result = await client.extension.retry({ id: item.id })
  expect(result.error).toBeUndefined()
  expect(result.data?.id).toBe(item.id)
  expect(result.data?.server).toMatchObject({ runtime: "idle", needsRestart: false })
})

test("retry rejects unknown, disabled, mutating and blocked extensions", async () => {
  await using tmp = await tmpdir()
  const root = await extensionPackage(tmp.path, { serverEntry: "dist/server.js" })
  const item = await ExtensionRegistry.link(root)
  const retryURL = `/global/extension/${item.id}/retry`
  expect((await request("/global/extension/test.missing/retry", "POST")).status).toBe(404)
  await ExtensionRegistry.setEnabled(item.id, false)
  expect((await request(retryURL, "POST")).status).toBe(409)
  await ExtensionRegistry.setEnabled(item.id, true)
  const release = ExtensionRuntime.beginMutation(item.id)
  try {
    expect((await request(retryURL, "POST")).status).toBe(409)
  } finally {
    release()
  }
  await Bun.write(
    path.join(root, "dist/server.js"),
    'export default { async activate() { return { dispose() { throw new Error("cannot dispose") } } } }',
  )
  await ExtensionRuntime.rpc({ id: item.id, method: "ping" }).catch(() => undefined)
  expect(await ExtensionRuntime.quiesce(item.id)).toEqual({ stopped: false, needsRestart: true })
  expect((await request(retryURL, "POST")).status).toBe(409)
  const detail = await request(`/global/extension/${item.id}`)
  expect((await detail.json()).server).toMatchObject({ runtime: "blocked", needsRestart: true })
})
