import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ExtensionHooks, ExtensionService, ServerExtension } from "@opencode-ai/extension-kit/server"
import { GlobalBus } from "../../src/bus/global"
import { ExtensionLeases } from "../../src/extension/leases"
import { ExtensionRuntime, type Options } from "../../src/extension/runtime"
import { tmpdir } from "../fixture/fixture"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T | "deadline exceeded"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<"deadline exceeded">((resolve) => (timer = setTimeout(() => resolve("deadline exceeded"), 500))),
    ])
  } finally {
    clearTimeout(timer)
  }
}

let options: Options
let rt: ReturnType<typeof ExtensionRuntime.make>

let temp: Awaited<ReturnType<typeof tmpdir>>
let previousRegistry: string | undefined
const modules = new Map<string, ServerExtension>()
const owned: ExtensionHooks[] = []
const cleanup: Array<() => void> = []

function input(name: string): PluginInput {
  const directory = path.join(temp.path, name)
  return {
    directory,
    worktree: directory,
    client: {},
    project: { id: "isolation" },
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
  } as unknown as PluginInput
}

async function hooks(name: string) {
  const result = await rt.instanceHooks(input(name))
  owned.push(...result.map((entry) => entry.hooks))
  return result
}

async function fixture(id: string, module: ServerExtension) {
  const dir = path.join(temp.path, id)
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: id.replaceAll(".", "-"),
      version: "1.0.0",
      type: "module",
      exports: { "./server": "./server.js" },
      opencode: { manifestVersion: 1, id, displayName: id, activation: ["onStartup"] },
    }),
  )
  await Bun.write(path.join(dir, "server.js"), "export default {}")
  const registry = process.env.OPENCODE_EXTENSION_REGISTRY_FILE!
  const store = await Bun.file(registry)
    .json()
    .catch(() => ({ version: 1, extensions: {} }))
  store.extensions[id] = {
    name: id.replaceAll(".", "-"),
    version: "1.0.0",
    source: { type: "path", path: dir },
    dir,
    enabled: true,
    installedAt: Date.now(),
  }
  await Bun.write(registry, JSON.stringify(store))
  modules.set(id, module)
}

beforeEach(async () => {
    options = {}
    rt = ExtensionRuntime.make(options)
  temp = await tmpdir()
  previousRegistry = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = path.join(temp.path, "registry.json")
  options.importer = (async (_source, _fingerprint, context) => modules.get(context.id)!)
  Object.assign(options, { activateMs: 150, serverMs: 150 })
})

afterEach(async () => {
  for (const release of cleanup.splice(0)) release()
  for (const entry of owned.splice(0)) await entry.dispose?.()
  await rt.testing.reset()
  modules.clear()
  if (previousRegistry === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previousRegistry
  await temp[Symbol.asyncDispose]()
})

describe("cross-extension isolation", () => {
  test("bounds a shared activation and starts healthy hooks before its deadline", async () => {
    const gate = deferred<ExtensionService>()
    cleanup.push(() => gate.resolve({}))
    const started = deferred()
    const healthy = deferred()
    let activations = 0
    await fixture("test.a", {
      activate: () => {
        activations++
        started.resolve()
        return gate.promise
      },
      server: async () => ({}),
    })
    await fixture("test.b", {
      activate: async () => ({}),
      server: async () => {
        healthy.resolve()
        return {}
      },
    })
    const statuses: Array<{ id: string; state: string; error?: string }> = []
    const listener = (event: any) => {
      if (event.payload.type === "extension.status") statuses.push(event.payload.properties)
    }
    GlobalBus.on("event", listener)
    cleanup.push(() => GlobalBus.off("event", listener))
    const first = hooks("first")
    await started.promise
    const second = hooks("second")
    expect(await bounded(healthy.promise)).not.toBe("deadline exceeded")
    const results = await bounded(Promise.all([first, second]))
    expect(results).not.toBe("deadline exceeded")
    if (results === "deadline exceeded") return
    expect(results.map((result) => result.map((entry) => entry.id))).toEqual([["test.b"], ["test.b"]])
    expect(activations).toBe(1)
    expect(statuses.filter((event) => event.id === "test.a" && event.state === "error")).toHaveLength(1)
    expect(statuses.find((event) => event.id === "test.a")?.error).toContain("activation timed out after 150ms")
    expect(rt.describe("test.a")?.hasService).toBe(false)
    expect((await hooks("sticky")).map((entry) => entry.id)).toEqual(["test.b"])
    expect(activations).toBe(1)
  })

  test("keeps the original timed-out activation observable to quiesce and disposes its late service once", async () => {
    const gate = deferred<ExtensionService>()
    cleanup.push(() => gate.resolve({}))
    const started = deferred()
    const disposed = deferred()
    let disposals = 0
    await fixture("test.a", {
      activate: () => {
        started.resolve()
        return gate.promise
      },
    })
    const building = hooks("first")
    await started.promise
    expect(await bounded(building)).toEqual([])
    const release = rt.beginMutation("test.a")
    cleanup.push(release)
    let stopped = false
    const stopping = rt.quiesce("test.a", { timeoutMs: 250 }).then((result) => {
      stopped = true
      return result
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    gate.resolve({
      dispose: () => {
        disposals++
        disposed.resolve()
      },
    })
    expect(await stopping).toEqual({ stopped: true, needsRestart: false })
    await disposed.promise
    expect(disposals).toBe(1)
    expect(rt.describe("test.a")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })
  })

  test("expires only the slow server call and permits another instance plus retained healthy hooks", async () => {
    const gate = deferred<ExtensionHooks>()
    cleanup.push(() => gate.resolve({}))
    const disposed = deferred()
    let activations = 0
    await fixture("test.a", {
      activate: async () => {
        activations++
        return {}
      },
      server: async (value) => (value.directory.endsWith("slow") ? gate.promise : { event: async () => {} }),
    })
    await fixture("test.b", { activate: async () => ({}), server: async () => ({}) })
    const healthy = await hooks("healthy")
    expect(healthy.map((entry) => entry.id)).toEqual(["test.a", "test.b"])
    const slow = await bounded(hooks("slow"))
    expect(slow).not.toBe("deadline exceeded")
    if (slow === "deadline exceeded") return
    expect(slow.map((entry) => entry.id)).toEqual(["test.b"])
    expect(rt.describe("test.a")?.hasService).toBe(true)
    await expect(healthy[0]!.hooks.event!({} as never)).resolves.toBeUndefined()
    expect((await hooks("retry")).map((entry) => entry.id)).toEqual(["test.a", "test.b"])
    expect(activations).toBe(1)
    gate.resolve({ dispose: () => disposed.resolve() })
    expect(await bounded(disposed.promise)).not.toBe("deadline exceeded")
    expect(await rt.quiesce("test.a", { timeoutMs: 25 })).toEqual({ stopped: false, needsRestart: true })
  })

  test("collects independent server jobs concurrently but preserves registry order", async () => {
    Object.assign(options, { activateMs: 1000, serverMs: 1000 })
    const gate = deferred()
    cleanup.push(() => gate.resolve())
    const second = deferred()
    await fixture("test.a", {
      activate: async () => ({}),
      server: async () => {
        await gate.promise
        return {}
      },
    })
    await fixture("test.b", {
      activate: async () => ({}),
      server: async () => {
        second.resolve()
        return {}
      },
    })
    const building = hooks("ordered")
    expect(await bounded(second.promise)).not.toBe("deadline exceeded")
    gate.resolve()
    expect((await building).map((entry) => entry.id)).toEqual(["test.a", "test.b"])
  })

  test("skips a permanently blocked extension without failing healthy peers", async () => {
    const gate = deferred()
    cleanup.push(() => gate.resolve())
    await fixture("test.a", { activate: async () => ({ dispose: () => gate.promise }) })
    await fixture("test.b", { activate: async () => ({}), server: async () => ({}) })
    await rt.rpc({ id: "test.a", method: "missing" }).catch(() => {})
    const release = rt.beginMutation("test.a")
    expect(await rt.quiesce("test.a", { timeoutMs: 5 })).toEqual({ stopped: false, needsRestart: true })
    release()
    expect((await hooks("blocked")).map((entry) => entry.id)).toEqual(["test.b"])
  })

  test("does not hot-loop invalidation while fenced and invalidates once after release", async () => {
    await fixture("test.a", { activate: async () => ({}), server: async () => ({}) })
    await fixture("test.b", { activate: async () => ({}), server: async () => ({}) })
    let invalidations = 0
    const invalidated = deferred()
    cleanup.push(
      rt.registerCacheInvalidator("plugin", async () => {
        invalidations++
        invalidated.resolve()
      }),
    )
    const release = rt.beginMutation("test.a")
    cleanup.push(release)
    expect((await hooks("fenced")).map((entry) => entry.id)).toEqual(["test.b"])
    // This delay is the negative assertion: repeated invalidation must not spin.
    await Bun.sleep(30)
    expect(invalidations).toBe(0)
    release()
    expect(await bounded(invalidated.promise)).not.toBe("deadline exceeded")
    expect(invalidations).toBe(1)
    expect((await hooks("released")).map((entry) => entry.id)).toEqual(["test.a", "test.b"])
  })

  test("drops only mutated hooks and defers stale invalidation until the result was delivered", async () => {
    const bGate = deferred()
    cleanup.push(() => bGate.resolve())
    const aReady = deferred()
    const bStarted = deferred()
    let disposed = 0
    await fixture("test.a", {
      activate: async () => ({}),
      server: async () => {
        aReady.resolve()
        return {
          dispose: () => {
            disposed++
          },
        }
      },
    })
    await fixture("test.b", {
      activate: async () => ({}),
      server: async () => {
        bStarted.resolve()
        await bGate.promise
        return {}
      },
    })
    let delivered = false
    const invalidated = deferred()
    let invalidatedAfterDelivery = false
    cleanup.push(
      rt.registerCacheInvalidator("plugin", async () => {
        invalidatedAfterDelivery = delivered
        invalidated.resolve()
      }),
    )
    const building = hooks("crossing").then((result) => {
      delivered = true
      return result
    })
    await Promise.all([aReady.promise, bStarted.promise])
    const release = rt.beginMutation("test.a")
    release()
    bGate.resolve()
    expect((await building).map((entry) => entry.id)).toEqual(["test.b"])
    expect(disposed).toBe(1)
    expect(await bounded(invalidated.promise)).not.toBe("deadline exceeded")
    expect(invalidatedAfterDelivery).toBe(true)
  })

  test("skips one failed lease acquisition without importing it or losing healthy peers", async () => {
    let badImports = 0
    await fixture("test.a", { activate: async () => ({}), server: async () => ({}) })
    await fixture("test.b", { activate: async () => ({}), server: async () => ({}) })
    options.importer = (async (_source, _fingerprint, context) => {
      if (context.id === "test.a") badImports++
      return modules.get(context.id)!
    })
    options.leases = ({
      acquire: ExtensionLeases.acquire,
      acquireData: async (registry, id) => {
        if (id === "test.a") throw new ExtensionLeases.LeaseError("busy", "fixture lease busy")
        return ExtensionLeases.acquireData(registry, id)
      },
    })
    expect((await hooks("lease")).map((entry) => entry.id)).toEqual(["test.b"])
    expect(badImports).toBe(0)
  })
})
