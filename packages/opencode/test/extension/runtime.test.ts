import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import type { PluginInput } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import { GlobalBus } from "../../src/bus/global"
import { ExtensionRegistry } from "../../src/extension/registry"
import {
  ExtensionRpcAbortedError,
  ExtensionRpcError,
  ExtensionRpcNotFoundError,
  ExtensionRuntime,
} from "../../src/extension/runtime"

const SERVER_SOURCE = `
const g = globalThis
g.__runtimeFixture = g.__runtimeFixture ?? {}
export default {
  id: "__EXTENSION_ID__",
  async activate(host) {
    const c = g.__runtimeFixture
    c.activate = (c.activate ?? 0) + 1
    c.activateHost = host
    if (c.activateFail) throw new Error("activate boom")
    if (c.activateGate) await new Promise((resolve) => { c.activateGateRelease = resolve })
    if (c.activateSlow) await new Promise((resolve) => setTimeout(resolve, 50))
    return {
      rpc: {
        ping: (input) => ({ pong: input, from: "process" }),
        count: () => {
          c.rpcCalls = (c.rpcCalls ?? 0) + 1
          return "counted"
        },
        signalCheck: (input, ctx) => ({ aborted: ctx.signal.aborted }),
        boom: () => {
          throw { name: "ExtensionRpcError", code: "KERNEL_DEAD", message: "kernel dead" }
        },
        raw: () => {
          throw new Error("raw failure")
        },
      },
      dispose: () => {
        const c = g.__runtimeFixture
        c.dispose = (c.dispose ?? 0) + 1
        if (c.disposeHang) return new Promise(() => {})
      },
    }
  },
  async server(input) {
    const c = g.__runtimeFixture
    c.server = (c.server ?? 0) + 1
    c.serverDirectories = [...(c.serverDirectories ?? []), input.directory]
    c.lastHost = input.extension
    if (c.serverGate) await new Promise((resolve) => { c.serverGateRelease = resolve })
    if (c.serverFail) throw new Error("server boom")
    return {
      rpc: {
        whoami: () => ({ directory: input.directory }),
      },
      dispose: () => {
        const c = g.__runtimeFixture
        c.instanceDispose = (c.instanceDispose ?? 0) + 1
      },
    }
  },
}
`

const BROKEN_SOURCE = `
export default new Proxy({}, {
  get() {
    throw new Error("module is broken")
  },
})
`

const RELOADED_SOURCE = `
const g = globalThis
g.__runtimeFixture = g.__runtimeFixture ?? {}
export default {
  id: "test.srv",
  async activate() {
    const c = g.__runtimeFixture
    c.activate = (c.activate ?? 0) + 1
    return {
      rpc: {
        ping: () => ({ pong: "reloaded", from: "copy-two" }),
      },
    }
  },
  async server() {
    return {}
  },
}
`

/** Server entry for the settings fixture: records the host for settings assertions. */
const SETTINGS_SOURCE = `
const g = globalThis
g.__runtimeFixture = g.__runtimeFixture ?? {}
export default {
  id: "test.settings",
  async activate() {
    return {}
  },
  async server(input) {
    const c = g.__runtimeFixture
    c.lastHost = input.extension
    return {}
  },
}
`

const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-runtime-"))

const registry = path.join(root, "registry.json")

const directories = [path.join(root, "instance-a"), path.join(root, "instance-b")]
let nextDirectory = 0

function counters(): Record<string, any> {
  return (globalThis as Record<string, any>).__runtimeFixture ?? {}
}

function pluginInput(): PluginInput {
  const directory = directories[nextDirectory++ % directories.length]
  return {
    client: {},
    project: { id: "project" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: undefined,
  } as unknown as PluginInput
}

async function writeServerPackage(id: string, source: string) {
  const name = id.replaceAll(".", "-")
  const dir = path.join(root, name)
  await mkdir(path.join(dir, "dist"), { recursive: true })
  await Bun.write(path.join(dir, "dist/server.js"), source.replaceAll("__EXTENSION_ID__", id))
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "1.0.0",
        type: "module",
        exports: { "./server": "./dist/server.js" },
        opencode: {
          manifestVersion: 1,
          id,
          displayName: "Test Extension",
          activation: ["onStartup"],
        },
      },
      null,
      2,
    ),
  )
  return dir
}

async function link(id: string, dir: string) {
  const store = (await Bun.file(registry)
    .json()
    .catch(() => ({ version: 1, extensions: {} }))) as {
    version: number
    extensions: Record<string, unknown>
  }
  store.extensions[id] = {
    name: id,
    version: "1.0.0",
    source: { type: "path", path: dir },
    dir,
    enabled: true,
    installedAt: Date.now(),
  }
  await Bun.write(registry, JSON.stringify(store, null, 2))
}

async function setSettings(id: string, settings: Record<string, unknown>) {
  const json = await Bun.file(registry).json()
  json.extensions[id].settings = settings
  await Bun.write(registry, JSON.stringify(json, null, 2))
}

function busProbe(type: string) {
  const seen: Array<Record<string, any>> = []
  const listener = (event: { payload: { type: string; properties?: Record<string, unknown> } }) => {
    if (event.payload.type === type && event.payload.properties) seen.push(event.payload.properties)
  }
  GlobalBus.on("event", listener)
  return {
    seen,
    stop() {
      GlobalBus.off("event", listener)
    },
  }
}

/** SERVER_SOURCE with the fixture id substituted, for rewriting the entry. */
const TEST_SERVER_SOURCE = SERVER_SOURCE.replaceAll("__EXTENSION_ID__", "test.srv")

/** Removes all module copies for an extension id so copy assertions are deterministic. */
async function resetModuleCopies(id: string) {
  await rm(path.join(Global.Path.tmp, "extension-modules", id), { recursive: true, force: true })
}

/** Fingerprint copy directories for an extension id containing `needle` in dist/server.js. */
async function copyDirsContaining(id: string, needle: string) {
  const idDir = path.join(Global.Path.tmp, "extension-modules", id)
  const versions = await readdir(idDir).catch(() => [] as string[])
  const matches: string[] = []
  for (const version of versions) {
    const entry = path.join(idDir, version, "dist", "server.js")
    const content = await readFile(entry, "utf8").catch(() => undefined)
    if (content?.includes(needle)) matches.push(path.join(idDir, version))
  }
  return matches
}

beforeAll(async () => {
  await writeServerPackage("test.srv", SERVER_SOURCE)
  await writeServerPackage("test.ok", SERVER_SOURCE)
  await writeServerPackage("test.broken", BROKEN_SOURCE)
})

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).__runtimeFixture = {}
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
})

afterEach(async () => {
  await ExtensionRuntime.testing.reset()
  await rm(registry, { force: true })
})

afterAll(async () => {
  delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  await rm(root, { recursive: true, force: true })
})

describe("extension runtime", () => {
  test("returns no hooks without touching the registry when disabled", async () => {
    await Bun.write(registry, "{ not json")
    expect(await ExtensionRuntime.instanceHooks(pluginInput(), { disabled: true })).toEqual([])
  })

  test("returns no hooks when the registry file is corrupt", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await Bun.write(registry, "{ not json")
    expect(await ExtensionRuntime.instanceHooks(pluginInput())).toEqual([])
  })

  test("skips registry rows whose directory is unreadable", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await link("test.gone", path.join(root, "does-not-exist"))
    const hooks = await ExtensionRuntime.instanceHooks(pluginInput())
    expect(hooks.map((item) => item.id)).toEqual(["test.srv"])
  })

  test("activates once and shares the process service across instances", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    const first = await ExtensionRuntime.instanceHooks(pluginInput())
    const second = await ExtensionRuntime.instanceHooks(pluginInput())
    expect(counters().activate).toBe(1)
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(first[0]!.id).toBe("test.srv")
    expect(second[0]!.hooks).not.toBe(first[0]!.hooks)
    expect(counters().server).toBe(2)

    const service = counters().lastHost as { service: object }
    expect(service.service).toBeDefined()
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: "hi" })).toEqual({
      pong: "hi",
      from: "process",
    })
    expect(ExtensionRuntime.describe("test.srv")).toEqual({ hasService: true, hasInstanceHooks: true })
  })

  test("passes host environment and settings to the extension", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await setSettings("test.srv", { token: "abc" })
    const input = pluginInput()
    await ExtensionRuntime.instanceHooks(input)
    const host = counters().lastHost as {
      id: string
      version: string
      dataDir: string
      cacheDir: string
      serverUrl: URL
      settings: { get(): Record<string, unknown> }
    }
    expect(host.id).toBe("test.srv")
    expect(host.version).toBe("1.0.0")
    expect(host.dataDir.endsWith(path.join("extensions", "data", "test.srv"))).toBe(true)
    expect(host.cacheDir.endsWith(path.join("extensions", "test.srv"))).toBe(true)
    expect(host.serverUrl.href).toBe(input.serverUrl.href)
    expect(host.settings.get()).toEqual({ token: "abc" })
  })

  test("deduplicates concurrent activations", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    counters().activateSlow = 1
    const [a, b] = await Promise.all([
      ExtensionRuntime.instanceHooks(pluginInput()),
      ExtensionRuntime.instanceHooks(pluginInput()),
    ])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(counters().activate).toBe(1)
  })

  test("resolves instance rpc by directory and process rpc otherwise", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    const first = pluginInput()
    const second = pluginInput()
    await ExtensionRuntime.instanceHooks(first)
    await ExtensionRuntime.instanceHooks(second)

    const fromFirst = await ExtensionRuntime.rpc({
      id: "test.srv",
      method: "whoami",
      directory: first.directory,
    })
    const fromSecond = await ExtensionRuntime.rpc({
      id: "test.srv",
      method: "whoami",
      directory: second.directory,
    })
    expect(fromFirst).toEqual({ directory: first.directory })
    expect(fromSecond).toEqual({ directory: second.directory })

    // Unknown directory falls through to the process-level handler.
    expect(
      await ExtensionRuntime.rpc({ id: "test.srv", method: "ping", directory: "/does/not/exist", input: 1 }),
    ).toEqual({ pong: 1, from: "process" })
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).toEqual({ pong: undefined, from: "process" })
  })

  test("throws ExtensionRpcNotFoundError for unroutable calls", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await ExtensionRuntime.instanceHooks(pluginInput())

    await expect(ExtensionRuntime.rpc({ id: "test.srv", method: "missing" })).rejects.toThrow(ExtensionRpcNotFoundError)

    // Enabled extension without any matching handler, instance or process.
    const noHandler = await ExtensionRuntime.rpc({ id: "test.srv", method: "nobody" }).catch((error) => error)
    expect(noHandler).toBeInstanceOf(ExtensionRpcNotFoundError)
    expect((noHandler as ExtensionRpcNotFoundError).id).toBe("test.srv")
    expect((noHandler as ExtensionRpcNotFoundError).method).toBe("nobody")
    expect((noHandler as Error).message).not.toContain(root)

    // Disabled extension.
    const store = await Bun.file(registry).json()
    store.extensions["test.srv"].enabled = false
    await Bun.write(registry, JSON.stringify(store))
    const disabled = await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" }).catch((error) => error)
    expect(disabled).toBeInstanceOf(ExtensionRpcNotFoundError)
  })

  test("normalizes duck-typed ExtensionRpcError and propagates other failures", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await ExtensionRuntime.instanceHooks(pluginInput())

    const domain = await ExtensionRuntime.rpc({ id: "test.srv", method: "boom" }).catch((error) => error)
    expect(domain).toBeInstanceOf(ExtensionRpcError)
    expect((domain as ExtensionRpcError).code).toBe("KERNEL_DEAD")
    expect((domain as Error).message).toBe("kernel dead")

    const raw = await ExtensionRuntime.rpc({ id: "test.srv", method: "raw" }).catch((error) => error)
    expect(raw).toBeInstanceOf(Error)
    expect((raw as Error).message).toBe("raw failure")
    expect((raw as Error).name).not.toBe("ExtensionRpcError")
  })

  test("does not invoke a handler whose signal is already aborted", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await ExtensionRuntime.instanceHooks(pluginInput())
    const controller = new AbortController()
    controller.abort()

    const error = await ExtensionRuntime.rpc({
      id: "test.srv",
      method: "count",
      signal: controller.signal,
    }).catch((error) => error)
    expect(error).toBeInstanceOf(ExtensionRpcAbortedError)
    expect((error as Error).name).toBe("AbortError")
    expect(counters().rpcCalls).toBeUndefined()
  })

  test("does not invoke a handler when the signal aborts during activation", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    counters().activateGate = 1
    const controller = new AbortController()
    const pending = ExtensionRuntime.rpc({
      id: "test.srv",
      method: "count",
      signal: controller.signal,
    }).catch((error) => error)
    controller.abort()
    counters().activateGateRelease?.()
    const error = await pending
    expect(error).toBeInstanceOf(ExtensionRpcAbortedError)
    expect(counters().rpcCalls).toBeUndefined()
  })

  test("passes a live signal to the handler when the call is not aborted", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await ExtensionRuntime.instanceHooks(pluginInput())
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "signalCheck" })).toEqual({ aborted: false })
  })

  test("isolates a broken extension and keeps the failure sticky", async () => {
    await link("test.ok", path.join(root, "test-ok"))
    await link("test.broken", path.join(root, "test-broken"))
    const status = busProbe("extension.status")
    try {
      const first = await ExtensionRuntime.instanceHooks(pluginInput())
      expect(first.map((item) => item.id)).toEqual(["test.ok"])

      const second = await ExtensionRuntime.instanceHooks(pluginInput())
      expect(second.map((item) => item.id)).toEqual(["test.ok"])

      expect(counters().activate).toBe(1)
      const errors = status.seen.filter((item) => item.id === "test.broken" && item.state === "error")
      expect(errors.length).toBeGreaterThan(0)
    } finally {
      status.stop()
    }
  })

  test("aborts in-flight handlers when an extension is disabled", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await ExtensionRuntime.instanceHooks(pluginInput())
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let observed: AbortSignal | undefined
    ExtensionRuntime.testing.setImporter(async () => ({
      id: "test.srv",
      async activate() {
        return {
          rpc: {
            wait: async (_input, ctx) => {
              observed = ctx.signal
              started()
              return new Promise((resolve) =>
                ctx.signal.addEventListener("abort", () => resolve("aborted"), { once: true }),
              )
            },
          },
        }
      },
    }))
    await ExtensionRuntime.reload("test.srv")
    const pending = ExtensionRuntime.rpc({ id: "test.srv", method: "wait" })
    await ready
    await ExtensionRuntime.disable("test.srv")
    expect(await pending).toBe("aborted")
    expect(observed?.aborted).toBe(true)
  })

  test("does not retry a failed activate until reload", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    counters().activateFail = 1
    expect(await ExtensionRuntime.instanceHooks(pluginInput())).toEqual([])
    expect(await ExtensionRuntime.instanceHooks(pluginInput())).toEqual([])
    expect(counters().activate).toBe(1)
    expect(ExtensionRuntime.describe("test.srv")?.hasService).toBe(false)

    counters().activateFail = undefined
    await ExtensionRuntime.reload("test.srv")
    const hooks = await ExtensionRuntime.instanceHooks(pluginInput())
    expect(hooks).toHaveLength(1)
    expect(counters().activate).toBe(2)
  })

  test("a settings change clears the sticky error and notifies listeners", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    counters().activateFail = 1
    expect(await ExtensionRuntime.instanceHooks(pluginInput())).toEqual([])

    counters().activateFail = undefined
    await ExtensionRuntime.notifySettings("test.srv", { token: "abc" })
    const hooks = await ExtensionRuntime.instanceHooks(pluginInput())
    expect(hooks).toHaveLength(1)
    expect(counters().activate).toBe(2)

    const host = counters().lastHost as {
      settings: {
        get(): Record<string, unknown>
        onDidChange(listener: (next: Record<string, unknown>) => void): () => void
      }
    }
    const seen: Record<string, unknown>[] = []
    const unsubscribe = host.settings.onDidChange((next) => seen.push(next))
    await ExtensionRuntime.notifySettings("test.srv", { token: "def" })
    expect(seen).toEqual([{ token: "def" }])
    expect(host.settings.get()).toEqual({ token: "def" })
    unsubscribe()
    await ExtensionRuntime.notifySettings("test.srv", { token: "ghi" })
    expect(seen).toEqual([{ token: "def" }])
  })

  test("disable disposes the service and honours the timeout override", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await ExtensionRuntime.instanceHooks(pluginInput())
    counters().disposeHang = 1

    const started = Date.now()
    await ExtensionRuntime.disable("test.srv", { timeoutMs: 20 })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(counters().dispose).toBe(1)
    expect(ExtensionRuntime.describe("test.srv")).toBeUndefined()

    // Stop hanging so the afterEach reset can dispose the re-activated service.
    counters().disposeHang = undefined
    const hooks = await ExtensionRuntime.instanceHooks(pluginInput())
    expect(hooks).toHaveLength(1)
    expect(counters().activate).toBe(2)
  })

  test("disable during import prevents a late re-insertion", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    let entered!: () => void
    const entering = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ExtensionRuntime.testing.setImporter(async (source) => {
      entered()
      await gate
      const module = await import(pathToFileURL(source).href)
      return module.default as never
    })

    const pending = ExtensionRuntime.instanceHooks(pluginInput())
    await entering
    await ExtensionRuntime.disable("test.srv")
    release()
    // The abandoned import must not surface hooks or an entry.
    expect(await pending).toEqual([])
    expect(ExtensionRuntime.describe("test.srv")).toBeUndefined()

    ExtensionRuntime.testing.setImporter(undefined)
    const hooks = await ExtensionRuntime.instanceHooks(pluginInput())
    expect(hooks).toHaveLength(1)
    expect(counters().activate).toBe(1)
  })

  test("a caller arriving during a reload-gated stale import starts a fresh import", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    let enteredFirst!: () => void
    const enteringFirst = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    let enteredSecond!: () => void
    const enteringSecond = new Promise<void>((resolve) => {
      enteredSecond = resolve
    })
    let releaseStale!: () => void
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    let releaseFresh!: () => void
    const freshGate = new Promise<void>((resolve) => {
      releaseFresh = resolve
    })
    let imports = 0
    ExtensionRuntime.testing.setImporter(async (source) => {
      const invocation = ++imports
      if (invocation === 1) {
        enteredFirst()
        await staleGate
      }
      if (invocation === 2) {
        enteredSecond()
        await freshGate
      }
      const module = await import(pathToFileURL(source).href)
      return module.default as never
    })

    const withTimeout = <T>(promise: Promise<T>, ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        promise,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), ms)
        }),
      ]).finally(() => clearTimeout(timer))
    }

    try {
      const stale = ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: "stale" }).catch((error) => error)
      await enteringFirst
      await ExtensionRuntime.reload("test.srv")
      // The stale import is still pending here; the fresh caller must start
      // its own import instead of joining the abandoned load.
      const fresh = ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: "fresh" })
      if ((await withTimeout(enteringSecond, 2500)) === "timeout")
        throw new Error("fresh import never started: caller joined the stale load")
      // The fresh load is registered in `loading` now. Releasing the stale
      // gate settles the abandoned import; its cleanup must not delete the
      // fresh loading entry.
      releaseStale()
      expect(await withTimeout(stale, 2500)).toBeInstanceOf(ExtensionRpcNotFoundError)
      // The abandoned import must not have revived its entry.
      expect(ExtensionRuntime.describe("test.srv")).toBeUndefined()
      // A third caller while the fresh load is still in flight joins it:
      // exactly two imports total, one shared activation.
      const third = ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: "third" })
      releaseFresh()
      expect(await withTimeout(fresh, 2500)).toEqual({ pong: "fresh", from: "process" })
      expect(await withTimeout(third, 2500)).toEqual({ pong: "third", from: "process" })
      expect(imports).toBe(2)
      expect(counters().activate).toBe(1)
    } finally {
      releaseStale()
      releaseFresh()
      ExtensionRuntime.testing.setImporter(undefined)
    }
  })

  test("disable then re-enable lets a fresh caller import instead of joining the stale load", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    let enteredFirst!: () => void
    const enteringFirst = new Promise<void>((resolve) => {
      enteredFirst = resolve
    })
    let enteredSecond!: () => void
    const enteringSecond = new Promise<void>((resolve) => {
      enteredSecond = resolve
    })
    let releaseStale!: () => void
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve
    })
    let imports = 0
    ExtensionRuntime.testing.setImporter(async (source) => {
      const invocation = ++imports
      if (invocation === 1) {
        enteredFirst()
        await staleGate
      }
      if (invocation === 2) enteredSecond()
      const module = await import(pathToFileURL(source).href)
      return module.default as never
    })

    const withTimeout = <T>(promise: Promise<T>, ms: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      return Promise.race([
        promise,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), ms)
        }),
      ]).finally(() => clearTimeout(timer))
    }

    try {
      const stale = ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: "stale" }).catch((error) => error)
      await enteringFirst
      const store = await Bun.file(registry).json()
      store.extensions["test.srv"].enabled = false
      await Bun.write(registry, JSON.stringify(store))
      await ExtensionRuntime.disable("test.srv")
      store.extensions["test.srv"].enabled = true
      await Bun.write(registry, JSON.stringify(store))
      const fresh = ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: "fresh" })
      if ((await withTimeout(enteringSecond, 2500)) === "timeout")
        throw new Error("fresh import never started: caller joined the stale load")
      // The stale import stays hung behind its gate; the fresh caller
      // completes anyway, proving the abandoned load blocks nothing.
      expect(await withTimeout(fresh, 2500)).toEqual({ pong: "fresh", from: "process" })
      expect(imports).toBe(2)
      expect(counters().activate).toBe(1)
      // Only now release the stale gate: the abandoned import settles without
      // resurrecting its entry or disturbing the fresh one.
      releaseStale()
      expect(await withTimeout(stale, 2500)).toBeInstanceOf(ExtensionRpcNotFoundError)
      expect(ExtensionRuntime.describe("test.srv")).toEqual({ hasService: true, hasInstanceHooks: true })
      expect(counters().activate).toBe(1)
    } finally {
      releaseStale()
      ExtensionRuntime.testing.setImporter(undefined)
    }
  })

  test("disable during activation discards the freshly activated service", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    counters().activateGate = 1
    const pending = ExtensionRuntime.instanceHooks(pluginInput())
    for (let i = 0; i < 5000 && !counters().activate; i++) await Bun.sleep(1)
    expect(counters().activate).toBe(1)

    await ExtensionRuntime.disable("test.srv")
    counters().activateGateRelease?.()
    expect(await pending).toEqual([])
    // The runtime disposes the service it can no longer cache.
    expect(counters().dispose).toBe(1)
    expect(ExtensionRuntime.describe("test.srv")).toBeUndefined()
    expect(counters().activate).toBe(1)
  })

  test("instance dispose removes the directory from the rpc map and still runs the hook", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    const input = pluginInput()
    const [entry] = await ExtensionRuntime.instanceHooks(input)
    const directory = input.directory as string

    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "whoami", directory })).toEqual({ directory })
    await entry!.hooks.dispose!()
    expect(counters().instanceDispose).toBe(1)

    const gone = await ExtensionRuntime.rpc({ id: "test.srv", method: "whoami", directory }).catch((error) => error)
    expect(gone).toBeInstanceOf(ExtensionRpcNotFoundError)
    // The process-level handler is unaffected.
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: 1 })).toEqual({
      pong: 1,
      from: "process",
    })
  })

  test("re-imports when the server fingerprint changes and disposes the old service", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    const imports: string[] = []
    ExtensionRuntime.testing.setImporter(async (source, fingerprint) => {
      imports.push(fingerprint ?? "")
      const module = await import(pathToFileURL(source).href)
      return module.default
    })
    await ExtensionRuntime.instanceHooks(pluginInput())
    expect(imports).toHaveLength(1)
    expect(counters().dispose).toBeUndefined()

    // Touch the server entry so the manifest serverFingerprint changes.
    const entry = path.join(root, "test-srv", "dist", "server.js")
    await Bun.write(entry, `${TEST_SERVER_SOURCE}\n// touched\n`)

    await ExtensionRuntime.instanceHooks(pluginInput())
    expect(imports).toHaveLength(2)
    expect(imports[0]).not.toEqual(imports[1])
    expect(counters().dispose).toBe(1)
    ExtensionRuntime.testing.setImporter(undefined)
  })

  test("hot reload imports a fresh module from a new copy without a fake importer", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await resetModuleCopies("test.srv")
    expect(await ExtensionRuntime.instanceHooks(pluginInput())).toHaveLength(1)
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: 1 })).toEqual({
      pong: 1,
      from: "process",
    })
    expect(counters().activate).toBe(1)
    const first = await copyDirsContaining("test.srv", 'from: "process"')
    expect(first).toHaveLength(1)
    // The import comes from the copied real path, not the linked source.
    expect(first[0]).toContain(path.join("extension-modules", "test.srv"))
    expect(await readFile(path.join(first[0]!, "dist", "server.js"), "utf8")).toContain(TEST_SERVER_SOURCE)

    // Change the server entry: same source path, new fingerprint, new copy.
    await Bun.write(path.join(root, "test-srv", "dist", "server.js"), RELOADED_SOURCE)
    expect(await ExtensionRuntime.instanceHooks(pluginInput())).toHaveLength(1)
    expect(counters().dispose).toBe(1)
    expect(counters().activate).toBe(2)
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).toEqual({
      pong: "reloaded",
      from: "copy-two",
    })
    const second = await copyDirsContaining("test.srv", 'from: "copy-two"')
    expect(second).toHaveLength(1)
    expect(second[0]).not.toBe(first[0])
    // The previous copy is retained.
    expect(await copyDirsContaining("test.srv", 'from: "process"')).toEqual(first)
  })

  test("repairs an existing module cache directory missing its entry", async () => {
    const dir = path.join(root, "test-srv")
    await Bun.write(path.join(dir, "dist", "server.js"), `${TEST_SERVER_SOURCE}\n// repair cache fixture\n`)
    await link("test.srv", dir)
    await resetModuleCopies("test.srv")
    const { load } = await import("../../src/extension/manifest")
    const manifest = await load(dir)
    const target = path.join(Global.Path.tmp, "extension-modules", "test.srv", manifest.serverFingerprint!)
    await mkdir(path.join(target, "dist", "web"), { recursive: true })
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping", input: "repaired" })).toEqual({
      pong: "repaired",
      from: "process",
    })
    expect(await readFile(path.join(target, "dist", "server.js"), "utf8")).toContain("test.srv")
  })

  test("copies the package with node_modules symlinked and .git excluded", async () => {
    const dir = path.join(root, "test-deps")
    await mkdir(path.join(dir, "dist"), { recursive: true })
    await mkdir(path.join(dir, "node_modules", "dep"), { recursive: true })
    await mkdir(path.join(dir, ".git"), { recursive: true })
    await Bun.write(
      path.join(dir, "node_modules", "dep", "package.json"),
      JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }),
    )
    await Bun.write(path.join(dir, "node_modules", "dep", "index.js"), "module.exports = 'dep-ok'\n")
    await Bun.write(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n")
    await Bun.write(
      path.join(dir, "dist", "server.js"),
      `
import dep from "dep"
export default {
  id: "test.deps",
  async activate() {
    return { rpc: { dep: () => dep } }
  },
}
`,
    )
    await Bun.write(
      path.join(dir, "package.json"),
      JSON.stringify(
        {
          name: "test-deps",
          version: "1.0.0",
          type: "module",
          exports: { "./server": "./dist/server.js" },
          opencode: {
            manifestVersion: 1,
            id: "test.deps",
            displayName: "Test Deps",
            activation: ["onStartup"],
          },
        },
        null,
        2,
      ),
    )
    await link("test.deps", dir)

    // rpc() alone drives import + activation through the module copy.
    expect(await ExtensionRuntime.rpc({ id: "test.deps", method: "dep" })).toBe("dep-ok")

    const copies = await copyDirsContaining("test.deps", "test.deps")
    expect(copies).toHaveLength(1)
    const copied = await readdir(copies[0]!)
    expect(copied).toContain("dist")
    expect(copied).toContain("node_modules")
    expect(copied).not.toContain(".git")

    const linkInfo = await lstat(path.join(copies[0]!, "node_modules"))
    expect(linkInfo.isSymbolicLink()).toBe(true)
    expect(await realpath(path.join(copies[0]!, "node_modules"))).toBe(await realpath(path.join(dir, "node_modules")))
  })

  test("prunes old module copies, keeping the recent ones", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await resetModuleCopies("test.srv")
    const idDir = path.join(Global.Path.tmp, "extension-modules", "test.srv")
    for (let version = 0; version < 4; version++) {
      await Bun.write(
        path.join(root, "test-srv", "dist", "server.js"),
        `${TEST_SERVER_SOURCE}\n// version ${version}\n`,
      )
      expect(await ExtensionRuntime.instanceHooks(pluginInput())).toHaveLength(1)
    }
    const versions = await readdir(idDir)
    expect(versions.length).toBeLessThanOrEqual(3)
    expect(await copyDirsContaining("test.srv", "// version 3")).toHaveLength(1)
  })

  test("emits extension.event through the global bus", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await ExtensionRuntime.instanceHooks(pluginInput())
    const host = counters().lastHost as { emit(name: string, data: unknown, options?: { directory?: string }): void }
    const bus = busProbe("extension.event")
    try {
      host.emit("cell.output", { text: "hi" })
      host.emit("kernel.status", { state: "busy" }, { directory: directories[0] })
      expect(bus.seen).toHaveLength(2)
      expect(bus.seen[0]).toMatchObject({ id: "test.srv", name: "cell.output", data: { text: "hi" } })
      expect(bus.seen[1]).toMatchObject({ id: "test.srv", name: "kernel.status" })
    } finally {
      bus.stop()
    }
  })

  test("disposeAll tears down every activated service", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    await ExtensionRuntime.instanceHooks(pluginInput())
    await ExtensionRuntime.disposeAll({ timeoutMs: 50 })
    expect(counters().dispose).toBe(1)
    expect(ExtensionRuntime.describe("test.srv")).toBeUndefined()
    expect((await ExtensionRegistry.list(() => "")).map((item) => item.id)).toEqual(["test.srv"])
  })

  test("disable while server() runs disposes the late hooks instead of registering them", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    counters().serverGate = 1
    const pending = ExtensionRuntime.instanceHooks(pluginInput())
    for (let i = 0; i < 5000 && !counters().server; i++) await Bun.sleep(1)
    expect(counters().server).toBe(1)

    await ExtensionRuntime.disable("test.srv")
    counters().serverGateRelease?.()
    expect(await pending).toEqual([])
    // The late hooks were disposed, not registered on the dead entry.
    expect(counters().instanceDispose).toBe(1)
    expect(ExtensionRuntime.describe("test.srv")).toBeUndefined()
  })

  test("reload while server() runs disposes the late hooks instead of registering them", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    counters().serverGate = 1
    const pending = ExtensionRuntime.instanceHooks(pluginInput())
    for (let i = 0; i < 5000 && !counters().server; i++) await Bun.sleep(1)

    await ExtensionRuntime.reload("test.srv")
    counters().serverGateRelease?.()
    expect(await pending).toEqual([])
    expect(counters().instanceDispose).toBe(1)
    expect(ExtensionRuntime.describe("test.srv")).toBeUndefined()
  })

  test("resolves manifest setting defaults for the host", async () => {
    const dir = path.join(root, "test-settings")
    await mkdir(path.join(dir, "dist"), { recursive: true })
    await Bun.write(path.join(dir, "dist/server.js"), SETTINGS_SOURCE)
    await Bun.write(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "test-settings",
        version: "1.0.0",
        type: "module",
        exports: { "./server": "./dist/server.js" },
        opencode: {
          manifestVersion: 1,
          id: "test.settings",
          displayName: "Test Settings",
          activation: ["onStartup"],
          contributes: {
            settings: {
              mode: { type: "string", title: "Mode", default: "auto" },
              limit: { type: "number", title: "Limit", default: 3 },
              token: { type: "string", title: "Token" },
            },
          },
        },
      }),
    )
    await link("test.settings", dir)

    // No stored values: every declared default is visible to the extension.
    await ExtensionRuntime.instanceHooks(pluginInput())
    const host = counters().lastHost as { settings: { get(): Record<string, unknown> } }
    expect(host.settings.get()).toEqual({ mode: "auto", limit: 3 })

    // Stored values override defaults; declared keys without a stored value
    // keep theirs, and the manifest defaults survive a registry update.
    await setSettings("test.settings", { mode: "manual" })
    await ExtensionRuntime.instanceHooks(pluginInput())
    expect((counters().lastHost as { settings: { get(): Record<string, unknown> } }).settings.get()).toEqual({
      mode: "manual",
      limit: 3,
    })
  })

  test("a settings update landing during the import is not lost", async () => {
    await link("test.settings", path.join(root, "test-settings"))
    let entered!: () => void
    const entering = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ExtensionRuntime.testing.setImporter(async (source) => {
      entered()
      await gate
      const module = await import(pathToFileURL(source).href)
      return module.default as never
    })

    const pending = ExtensionRuntime.instanceHooks(pluginInput())
    await entering
    // The update commits (and notify fires) while the entry is still importing.
    await setSettings("test.settings", { mode: "manual" })
    await ExtensionRuntime.notifySettings("test.settings", { mode: "manual" })
    release()

    expect(await pending).toHaveLength(1)
    const host = counters().lastHost as { settings: { get(): Record<string, unknown> } }
    expect(host.settings.get()).toEqual({ mode: "manual", limit: 3 })
  })

  test("notifySettings listeners observe the same resolved snapshot as host.settings.get", async () => {
    await link("test.settings", path.join(root, "test-settings"))
    await ExtensionRuntime.instanceHooks(pluginInput())
    const host = counters().lastHost as {
      settings: {
        get(): Record<string, unknown>
        onDidChange(listener: (next: Record<string, unknown>) => void): () => void
      }
    }
    expect(host.settings.get()).toEqual({ mode: "auto", limit: 3 })
    const seen: Record<string, unknown>[] = []
    const unsubscribe = host.settings.onDidChange((next) => seen.push(next))
    await ExtensionRuntime.notifySettings("test.settings", { mode: "manual" })
    // The listener must observe the same fully resolved snapshot the host
    // exposes, manifest defaults included.
    expect(seen).toEqual([{ mode: "manual", limit: 3 }])
    expect(host.settings.get()).toEqual({ mode: "manual", limit: 3 })
    unsubscribe()
  })
})
