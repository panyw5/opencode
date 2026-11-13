import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ServerExtension } from "@opencode-ai/extension-kit/server"
import { GlobalBus } from "../../src/bus/global"
import { ExtensionRuntime, ExtensionMutationError, type Options } from "../../src/extension/runtime"
import { tmpdir } from "../fixture/fixture"

let options: Options
let rt: ReturnType<typeof ExtensionRuntime.make>

let temp: Awaited<ReturnType<typeof tmpdir>>
let previousRegistry: string | undefined
let module: ServerExtension

beforeEach(async () => {
    options = {}
    rt = ExtensionRuntime.make(options)
  temp = await tmpdir()
  previousRegistry = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = path.join(temp.path, "registry.json")
  const dir = path.join(temp.path, "extension")
  await Bun.write(path.join(dir, "server.js"), "export default {}")
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "test-runtime-status",
      version: "1.0.0",
      type: "module",
      exports: { "./server": "./server.js" },
      opencode: { manifestVersion: 1, id: "test.status", displayName: "Runtime status", activation: ["onStartup"] },
    }),
  )
  await Bun.write(
    process.env.OPENCODE_EXTENSION_REGISTRY_FILE,
    JSON.stringify({
      version: 1,
      extensions: {
        "test.status": {
          name: "test-runtime-status",
          version: "1.0.0",
          source: { type: "path", path: dir },
          dir,
          enabled: true,
          installedAt: Date.now(),
        },
      },
    }),
  )
  module = { activate: async () => ({ rpc: { ping: () => "ok" } }) }
  options.importer = (async () => module)
})

afterEach(async () => {
  await rt.testing.reset()
  if (previousRegistry === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previousRegistry
  await temp[Symbol.asyncDispose]()
})

describe("extension runtime status and retry", () => {
  test("describes idle, loading, ready and sticky activation error", async () => {
    expect(rt.describe("test.status")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let started!: () => void
    const starting = new Promise<void>((resolve) => (started = resolve))
    module = {
      activate: async () => {
        started()
        await gate
        throw new Error("status activation failed")
      },
    }
    const call = rt.rpc({ id: "test.status", method: "ping" }).catch(() => {})
    await starting
    expect(rt.describe("test.status")).toMatchObject({ runtime: "loading", needsRestart: false })
    release()
    await call
    expect(rt.describe("test.status")).toMatchObject({
      runtime: "error",
      error: "status activation failed",
      needsRestart: false,
    })
    await rt.reload("test.status")
    module = { activate: async () => ({ rpc: { ping: () => "ok" } }) }
    expect(await rt.rpc({ id: "test.status", method: "ping" })).toBe("ok")
    expect(rt.describe("test.status")).toMatchObject({
      runtime: "ready",
      hasService: true,
      needsRestart: false,
    })
  })

  test("retains disposal failure after entry removal, emits blocked and refuses retry synchronously", async () => {
    module = {
      activate: async () => ({
        rpc: { ping: () => "ok" },
        dispose: () => {
          throw new Error("dispose status boom")
        },
      }),
    }
    await rt.rpc({ id: "test.status", method: "ping" })
    const statuses: any[] = []
    const listener = (event: any) => {
      if (event.payload.type === "extension.status") statuses.push(event.payload.properties)
    }
    GlobalBus.on("event", listener)
    try {
      const release = rt.beginMutation("test.status")
      expect(await rt.quiesce("test.status", { timeoutMs: 100 })).toEqual({
        stopped: false,
        needsRestart: true,
      })
      release()
      expect(rt.describe("test.status")).toMatchObject({
        runtime: "blocked",
        error: "dispose status boom",
        needsRestart: true,
        hasService: false,
      })
      expect(statuses).toContainEqual({
        id: "test.status",
        version: "1.0.0",
        state: "blocked",
        error: "dispose status boom",
      })
      expect(() => rt.retry("test.status")).toThrow(ExtensionMutationError)
      await rt.reload("test.status")
      expect(rt.describe("test.status")).toMatchObject({
        runtime: "blocked",
        error: "dispose status boom",
        needsRestart: true,
      })
    } finally {
      GlobalBus.off("event", listener)
    }
  })

  test("a directory server timeout stays visible but is not a sticky activation error", async () => {
    Object.assign(options, { serverMs: 40 })
    let finish!: (value: {}) => void
    const late = new Promise<{}>((resolve) => {
      finish = resolve
    })
    module = { activate: async () => ({}), server: async (input) => (input.directory.endsWith("slow") ? late : {}) }
    const input = (name: string) =>
      ({
        directory: path.join(temp.path, name),
        worktree: temp.path,
        project: {},
        client: {},
        serverUrl: new URL("http://localhost:4096"),
        experimental_workspace: { register() {} },
      }) as unknown as PluginInput
    try {
      expect(await rt.instanceHooks(input("slow"))).toEqual([])
      expect(rt.describe("test.status")).toMatchObject({
        runtime: "error",
        hasService: true,
        needsRestart: false,
        error: "server timed out after 40ms",
      })
      const next = await rt.instanceHooks(input("healthy"))
      expect(next).toHaveLength(1)
      expect(rt.describe("test.status")).toMatchObject({ runtime: "ready", needsRestart: false })
      expect(rt.describe("test.status").error).toBeUndefined()
      await next[0]!.hooks.dispose?.()
    } finally {
      finish({})
    }
  })

  test("retry clears a recoverable error and invalidates caches but rejects a held fence", async () => {
    module = {
      activate: async () => {
        throw new Error("recoverable")
      },
    }
    await rt.rpc({ id: "test.status", method: "ping" }).catch(() => {})
    let invalidations = 0
    const unregister = rt.registerCacheInvalidator("plugin", async () => {
      invalidations++
    })
    try {
      const release = rt.beginMutation("test.status")
      expect(() => rt.retry("test.status")).toThrow(ExtensionMutationError)
      release()
      await rt.retry("test.status")
      expect(invalidations).toBe(1)
      expect(rt.describe("test.status")).toMatchObject({ runtime: "idle", needsRestart: false })
      module = { activate: async () => ({ rpc: { ping: () => "recovered" } }) }
      expect(await rt.rpc({ id: "test.status", method: "ping" })).toBe("recovered")
    } finally {
      unregister()
    }
  })
})
