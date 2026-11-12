import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import type { PluginInput } from "@opencode-ai/plugin"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { GlobalBus } from "../../src/bus/global"
import { ExtensionRegistry, registryFile } from "../../src/extension/registry"
import { ExtensionLeases } from "../../src/extension/leases"
import { Effect } from "effect"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import {
  ExtensionMutationError,
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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

describe("extension mutation gate", () => {
  beforeEach(async () => {
    await link("test.srv", path.join(root, "test-srv"))
  })

  test("rejects duplicate mutations and RPC without importing, then loads after release", async () => {
    let imports = 0
    ExtensionRuntime.testing.setImporter(async () => {
      imports++
      return { activate: async () => ({ rpc: { ping: () => "new" } }) }
    })
    const release = ExtensionRuntime.beginMutation("test.srv")
    expect(() => ExtensionRuntime.beginMutation("test.srv")).toThrow(ExtensionMutationError)
    await expect(ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).rejects.toThrow(ExtensionMutationError)
    expect(await ExtensionRuntime.instanceHooks(pluginInput())).toEqual([])
    expect(imports).toBe(0)
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 50 })).toEqual({
      stopped: true,
      needsRestart: false,
    })
    release()
    release()
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).toBe("new")
    expect(imports).toBe(1)
  })

  test("a skipped mutation expires the production InstanceState cache after release", async () => {
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => ({}),
      server: async () => ({ tool: { example: { description: "example", args: {}, execute: async () => "new" } } }),
    }))
    const input = pluginInput()
    const context = { directory: input.directory, directoryKey: input.directory } as InstanceContext
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let attempts = 0
          const state = yield* InstanceState.make(() =>
            Effect.acquireRelease(
              Effect.tryPromise({
                try: () => {
                  attempts++
                  return ExtensionRuntime.instanceHooks(input)
                },
                catch: (error) => error,
              }),
              (entries) =>
                Effect.promise(async () => {
                  for (const entry of entries) await entry.hooks.dispose?.()
                }),
            ),
          )
          const get = InstanceState.get(state).pipe(Effect.provideService(InstanceRef, context))
          const invalidated = deferred()
          const unregister = ExtensionRuntime.registerCacheInvalidator("plugin", async () => {
            await Effect.runPromise(InstanceState.invalidateAll(state))
            invalidated.resolve()
          })
          const release = ExtensionRuntime.beginMutation("test.srv")
          try {
            expect(yield* get).toEqual([])
            release()
            yield* Effect.promise(() => invalidated.promise)
            const entries = yield* get
            expect(entries).toHaveLength(1)
            expect(entries[0]!.hooks.tool?.example).toBeDefined()
            expect(yield* get).toBe(entries)
            expect(attempts).toBe(2)
          } finally {
            release()
            unregister()
          }
        }),
      ),
    )
  })

  test.each(["tool", "chat", "event"] as const)(
    "quiesce drains %s calls and rejects retained old-generation hooks",
    async (kind) => {
      const started = deferred()
      const gate = deferred()
      let receiver: unknown
      ExtensionRuntime.testing.setImporter(async () => ({
        activate: async () => ({}),
        server: async () => {
          async function run(this: unknown) {
            receiver = this
            started.resolve()
            await gate.promise
            return "done"
          }
          return {
            tool: { example: { description: "example", args: {}, execute: run } },
            "chat.message": run,
            event: run,
            dispose: async () => {},
          }
        },
      }))
      const [entry] = await ExtensionRuntime.instanceHooks(pluginInput())
      const hooks = entry!.hooks
      const invoke = () =>
        kind === "tool"
          ? hooks.tool!.example!.execute({}, {} as never)
          : kind === "chat"
            ? hooks["chat.message"]!({} as never, {} as never)
            : hooks.event!({} as never)
      const running = invoke()
      expect(running).toBeInstanceOf(Promise)
      await started.promise
      expect(receiver).toBe(kind === "tool" ? hooks.tool!.example : hooks)
      const release = ExtensionRuntime.beginMutation("test.srv")
      await hooks.dispose!()
      let finished = false
      const stopping = ExtensionRuntime.quiesce("test.srv", { timeoutMs: 100 }).then((result) => {
        finished = true
        return result
      })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(finished).toBe(false)
      gate.resolve()
      await running
      expect(await stopping).toEqual({ stopped: true, needsRestart: false })
      release()
      expect(invoke).toThrow(ExtensionMutationError)
    },
  )

  test("tool calls receive a mutation abort signal without altering the caller's context", async () => {
    let received: AbortSignal | undefined
    let syncThis: unknown
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => ({}),
      server: async () => ({
        tool: {
          cooperative: {
            description: "cooperative",
            args: {},
            execute: (_args, context) =>
              new Promise((resolve) => {
                received = context.abort
                context.abort.addEventListener("abort", () => resolve("aborted"), { once: true })
              }),
          },
          synchronous: {
            description: "synchronous",
            args: {},
            execute: function () {
              syncThis = this
              return "sync" as never
            },
          },
        },
      }),
    }))
    const [entry] = await ExtensionRuntime.instanceHooks(pluginInput())
    const tools = entry!.hooks.tool!
    expect(tools.synchronous!.execute({}, {} as never) as unknown).toBe("sync")
    expect(syncThis).toBe(tools.synchronous)
    const caller = new AbortController()
    const context = { abort: caller.signal }
    const running = tools.cooperative!.execute({}, context as never)
    expect(context.abort).toBe(caller.signal)
    const release = ExtensionRuntime.beginMutation("test.srv")
    await entry!.hooks.dispose!()
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 100 })).toEqual({
      stopped: true,
      needsRestart: false,
    })
    expect(await running).toBe("aborted")
    expect(received?.aborted).toBe(true)
    expect(caller.signal.aborted).toBe(false)
    release()
  })

  test("noncooperative tool work blocks strict replacement even after its hooks dispose", async () => {
    const gate = deferred()
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => ({}),
      server: async () => ({
        tool: {
          example: {
            description: "example",
            args: {},
            execute: async () => {
              await gate.promise
              return "late"
            },
          },
        },
      }),
    }))
    const [entry] = await ExtensionRuntime.instanceHooks(pluginInput())
    const running = entry!.hooks.tool!.example!.execute({}, {} as never)
    const release = ExtensionRuntime.beginMutation("test.srv")
    await entry!.hooks.dispose!()
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 10 })).toEqual({
      stopped: false,
      needsRestart: true,
    })
    release()
    gate.resolve()
    await running
    expect(() => entry!.hooks.tool!.example!.execute({}, {} as never)).toThrow(ExtensionMutationError)
  })

  test("drains a late import without resurrecting it or invoking RPC", async () => {
    const started = deferred()
    const gate = deferred()
    let calls = 0
    ExtensionRuntime.testing.setImporter(async () => {
      started.resolve()
      await gate.promise
      return {
        activate: async () => ({
          rpc: {
            ping: () => {
              calls++
              return "late"
            },
          },
        }),
      }
    })
    const pending = ExtensionRuntime.rpc({ id: "test.srv", method: "ping" }).catch((error) => error)
    await started.promise
    const release = ExtensionRuntime.beginMutation("test.srv")
    const stopped = ExtensionRuntime.quiesce("test.srv", { timeoutMs: 100 })
    gate.resolve()
    expect(await stopped).toEqual({ stopped: true, needsRestart: false })
    release()
    expect(await pending).toBeInstanceOf(ExtensionMutationError)
    expect(calls).toBe(0)
    expect(ExtensionRuntime.describe("test.srv")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })
  })

  test("disposes a late activation exactly once before allowing a new generation", async () => {
    const started = deferred()
    const gate = deferred()
    let disposed = 0
    let activated = 0
    let calls = 0
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => {
        if (++activated === 1) {
          started.resolve()
          await gate.promise
        }
        return {
          rpc: {
            ping: () => {
              calls++
              return activated
            },
          },
          dispose: () => {
            disposed++
          },
        }
      },
    }))
    const pending = ExtensionRuntime.rpc({ id: "test.srv", method: "ping" }).catch((error) => error)
    await started.promise
    const release = ExtensionRuntime.beginMutation("test.srv")
    const stopped = ExtensionRuntime.quiesce("test.srv", { timeoutMs: 100 })
    gate.resolve()
    expect(await stopped).toEqual({ stopped: true, needsRestart: false })
    expect(await pending).toBeInstanceOf(ExtensionMutationError)
    expect(disposed).toBe(1)
    expect(calls).toBe(0)
    release()
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).toBe(2)
  })

  test("bounds hanging dispose and preserves needsRestart across release and reload", async () => {
    const hang = deferred()
    let disposed = 0
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => ({
        rpc: { ping: () => "ok" },
        dispose: () => {
          disposed++
          return hang.promise
        },
      }),
    }))
    await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })
    const release = ExtensionRuntime.beginMutation("test.srv")
    const time = Date.now()
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 10 })).toEqual({
      stopped: false,
      needsRestart: true,
    })
    expect(Date.now() - time).toBeLessThan(1000)
    release()
    hang.resolve()
    await ExtensionRuntime.reload("test.srv")
    await expect(ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).rejects.toThrow(ExtensionMutationError)
    expect(() => ExtensionRuntime.beginMutation("test.srv")).toThrow(ExtensionMutationError)
    expect(disposed).toBe(1)
  })

  test("marks throwing disposal blocked instead of reporting a clean stop", async () => {
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => ({
        rpc: { ping: () => "ok" },
        dispose: () => {
          throw new Error("dispose failed")
        },
      }),
    }))
    await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })
    const release = ExtensionRuntime.beginMutation("test.srv")
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 50 })).toEqual({
      stopped: false,
      needsRestart: true,
    })
    release()
    const error = await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" }).catch((error) => error)
    expect(error).toBeInstanceOf(ExtensionMutationError)
    expect(error.needsRestart).toBe(true)
  })

  test("tracks noncooperative requests even after legacy disable clears the entry", async () => {
    const started = deferred()
    const gate = deferred()
    let signal: AbortSignal | undefined
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => ({
        rpc: {
          wait: async (_input, ctx) => {
            signal = ctx.signal
            started.resolve()
            await gate.promise
            return "late"
          },
        },
      }),
    }))
    const pending = ExtensionRuntime.rpc({ id: "test.srv", method: "wait" }).catch((error) => error)
    await started.promise
    await ExtensionRuntime.disable("test.srv")
    const release = ExtensionRuntime.beginMutation("test.srv")
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 10 })).toEqual({
      stopped: false,
      needsRestart: true,
    })
    expect(signal?.aborted).toBe(true)
    gate.resolve()
    expect(await pending).toBeInstanceOf(ExtensionMutationError)
    release()
    expect(() => ExtensionRuntime.beginMutation("test.srv")).toThrow(ExtensionMutationError)
  })

  test("drains cooperative abort and reloads only after release", async () => {
    const started = deferred()
    let activations = 0
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => {
        const version = ++activations
        return {
          rpc: {
            ping: () => version,
            wait: (_input, ctx) =>
              new Promise((resolve) => {
                ctx.signal.addEventListener("abort", () => resolve("aborted"), { once: true })
                started.resolve()
              }),
          },
        }
      },
    }))
    const pending = ExtensionRuntime.rpc({ id: "test.srv", method: "wait" }).catch((error) => error)
    await started.promise
    const release = ExtensionRuntime.beginMutation("test.srv")
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 100 })).toEqual({
      stopped: true,
      needsRestart: false,
    })
    expect(await pending).toBeInstanceOf(ExtensionMutationError)
    await expect(ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).rejects.toThrow(ExtensionMutationError)
    release()
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).toBe(2)
  })

  test("disposes late hooks once but conservatively blocks live externally owned hooks", async () => {
    const started = deferred()
    const gate = deferred()
    let disposed = 0
    let servers = 0
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => ({}),
      server: async () => {
        if (++servers === 1) {
          started.resolve()
          await gate.promise
        }
        return {
          dispose: () => {
            disposed++
          },
        }
      },
    }))
    const pending = ExtensionRuntime.instanceHooks(pluginInput()).catch((error) => error)
    await started.promise
    let release = ExtensionRuntime.beginMutation("test.srv")
    const stopped = ExtensionRuntime.quiesce("test.srv", { timeoutMs: 100 })
    gate.resolve()
    expect(await stopped).toEqual({ stopped: true, needsRestart: false })
    expect(await pending).toEqual([])
    expect(disposed).toBe(1)
    release()
    const [instance] = await ExtensionRuntime.instanceHooks(pluginInput())
    release = ExtensionRuntime.beginMutation("test.srv")
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 100 })).toEqual({
      stopped: false,
      needsRestart: true,
    })
    expect(disposed).toBe(1)
    await Promise.all([instance!.hooks.dispose!(), instance!.hooks.dispose!()])
    expect(disposed).toBe(2)
    release()
    expect(() => ExtensionRuntime.beginMutation("test.srv")).toThrow(ExtensionMutationError)
  })
})

describe("extension runtime process pins", () => {
  const installId = "f2cf8c3b-4cb8-4a91-8449-2b655bda0df1"

  afterEach(async () => {
    await ExtensionRuntime.testing.reset()
    // This fixture alone switches test.srv between managed and path sources.
    // Remove only its verified metadata; never touch extension data or cache.
    const owner = path.join(Global.Path.data, "extensions", "data-ownership", "test.srv.json")
    const record = await Bun.file(owner)
      .json()
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
    if (!record) return
    expect(record.owner).toBe("opencode.extension-data")
    expect(record.id).toBe("test.srv")
    expect(record.name).toBe("test-srv")
    expect(record.sourceHash).toBe(
      createHash("sha256")
        .update(`archive:${"0".repeat(64)}`)
        .digest("hex"),
    )
    await rm(owner)
  })

  async function managed(id = installId) {
    const dir = await writeServerPackage("test.srv", SERVER_SOURCE)
    await link("test.srv", dir)
    const packageDir = path.join(path.dirname(registryFile()), "packages", id, "package")
    await mkdir(path.join(packageDir, "dist"), { recursive: true })
    await Bun.write(path.join(packageDir, "package.json"), await Bun.file(path.join(dir, "package.json")).text())
    await Bun.write(path.join(packageDir, "dist/server.js"), TEST_SERVER_SOURCE)
    const store = await Bun.file(registry).json()
    Object.assign(store.extensions["test.srv"], {
      name: "test-srv",
      dir: packageDir,
      installId: id,
      source: { type: "archive", location: "fixture.zip", sha256: "0".repeat(64) },
    })
    await Bun.write(registry, JSON.stringify(store))
  }

  function driver(proof: "flock" | "unsupported" = "flock") {
    const events: string[] = []
    const lease = (kind: string) => {
      events.push(`acquire:${kind}`)
      const release = async () => {
        events.push(`release:${kind}`)
      }
      return { proof, release, [Symbol.asyncDispose]: release }
    }
    ExtensionRuntime.testing.setLeaseDriver({
      acquire: async (target, id) => {
        expect(target).toBe(registryFile())
        return lease(id)
      },
      acquireData: async (target, id) => {
        expect(target).toBe(registryFile())
        return lease(`data:${id}`)
      },
    })
    ExtensionRuntime.testing.setImporter(async () => {
      events.push("import")
      return { activate: async () => ({ rpc: { ping: () => "ok" } }) }
    })
    return { events, lease }
  }

  test("acquires data and managed generation before import and pins through strict teardown", async () => {
    await managed()
    const { events } = driver()
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).toBe("ok")
    expect(events).toEqual(["acquire:data:test.srv", `acquire:${installId}`, "import"])
    await ExtensionRuntime.disable("test.srv")
    await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })
    await ExtensionRuntime.reload("test.srv")
    await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })
    const release = ExtensionRuntime.beginMutation("test.srv")
    expect(await ExtensionRuntime.quiesce("test.srv")).toEqual({ stopped: true, needsRestart: false })
    release()
    expect(events.filter((value) => value.startsWith("release:"))).toEqual([])
    expect(events.filter((value) => value.startsWith("acquire:"))).toHaveLength(2)
    await ExtensionRuntime.testing.reset()
    expect(events.filter((value) => value.startsWith("release:"))).toHaveLength(2)
  })

  test("path extensions pin data but do not acquire package generations", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    const { events } = driver()
    await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })
    await ExtensionRuntime.disposeAll()
    expect(events).toEqual(["acquire:data:test.srv", "import"])
  })

  test("tracks an acquisition across quiesce and releases only never-imported handles", async () => {
    await managed()
    const { events, lease } = driver()
    const started = deferred()
    const gate = deferred()
    ExtensionRuntime.testing.setLeaseDriver({
      acquireData: async () => lease("data:test.srv"),
      acquire: async () => {
        started.resolve()
        await gate.promise
        return lease(installId)
      },
    })
    const pending = ExtensionRuntime.rpc({ id: "test.srv", method: "ping" }).catch((error) => error)
    await started.promise
    const release = ExtensionRuntime.beginMutation("test.srv")
    let settled = false
    const stop = ExtensionRuntime.quiesce("test.srv", { timeoutMs: 100 }).then((value) => {
      settled = true
      return value
    })
    await Bun.sleep(1)
    expect(settled).toBe(false)
    gate.resolve()
    expect(await stop).toEqual({ stopped: true, needsRestart: false })
    expect(await pending).toBeInstanceOf(ExtensionMutationError)
    expect(events).not.toContain("import")
    expect(events).toContain(`release:${installId}`)
    release()
  })

  test("retains imported pins after uncertain stop even when old work later settles", async () => {
    await managed()
    const { events } = driver()
    const started = deferred()
    const gate = deferred()
    ExtensionRuntime.testing.setImporter(async () => ({
      activate: async () => ({
        rpc: {
          wait: async () => {
            started.resolve()
            await gate.promise
            return "done"
          },
        },
      }),
    }))
    const pending = ExtensionRuntime.rpc({ id: "test.srv", method: "wait" }).catch((error) => error)
    await started.promise
    const release = ExtensionRuntime.beginMutation("test.srv")
    expect(await ExtensionRuntime.quiesce("test.srv", { timeoutMs: 5 })).toEqual({ stopped: false, needsRestart: true })
    gate.resolve()
    await pending
    release()
    await ExtensionRuntime.reload("test.srv")
    expect(events.filter((value) => value.startsWith("release:"))).toEqual([])
  })

  test("keeps every imported generation pinned and accepts unsupported proof", async () => {
    await managed()
    const { events } = driver("unsupported")
    await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })
    const next = "80917ce0-afdd-419f-8304-91971f3f389f"
    await managed(next)
    await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })
    expect(events).toEqual(["acquire:data:test.srv", `acquire:${installId}`, "import", `acquire:${next}`, "import"])
    expect(await ExtensionRuntime.quiesce("test.srv")).toEqual({ stopped: true, needsRestart: false })
    expect(events.filter((value) => value.startsWith("release:"))).toEqual([])
  })

  test("revalidates managed ownership after acquisition before importing", async () => {
    await managed()
    const { events, lease } = driver()
    ExtensionRuntime.testing.setLeaseDriver({
      acquireData: async () => lease("data:test.srv"),
      acquire: async () => {
        await rm(path.join(path.dirname(registryFile()), "packages", installId), { recursive: true, force: true })
        return lease(installId)
      },
    })
    await expect(ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).rejects.toThrow("owned installation")
    expect(events).not.toContain("import")
  })

  test("does not import when generation acquisition fails and can retry safely", async () => {
    await managed()
    const { events, lease } = driver()
    let busy = true
    ExtensionRuntime.testing.setLeaseDriver({
      acquireData: async () => lease("data:test.srv"),
      acquire: async () => {
        if (busy) throw new ExtensionLeases.LeaseError("busy", "lease busy")
        return lease(installId)
      },
    })
    await expect(ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).rejects.toThrow("lease busy")
    expect(await ExtensionRuntime.instanceHooks(pluginInput())).toEqual([])
    expect(events).not.toContain("import")
    busy = false
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "ping" })).toBe("ok")
    expect(events.filter((value) => value === "acquire:data:test.srv")).toHaveLength(1)
  })
})

describe("extension runtime limits", () => {
  test("rejects RPC beyond the per-extension concurrency cap with code busy", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    ExtensionRuntime.testing.setLimits({ rpcConcurrency: 2 })
    const gate = deferred()
    let running = 0
    let busy = 0
    let other = 0
    ExtensionRuntime.testing.setImporter(async () => ({
      id: "test.srv",
      async activate() {
        return {
          rpc: {
            wait: async () => {
              running++
              await gate.promise
              return "done"
            },
          },
        }
      },
    }))
    // Concurrent callers resume in microtask order, not initiation order: any
    // one of the three may lose the admission race, and a straggler could even
    // reach admission after the gate released. Hold the gate until every call
    // is accounted for — running the handler, rejected busy, or other error —
    // so the assertion is deterministic.
    const calls = Array.from({ length: 3 }, () =>
      ExtensionRuntime.rpc({ id: "test.srv", method: "wait" }).then(
        () => "done",
        (error: unknown) => {
          if (error instanceof ExtensionRpcError && error.code === "busy") busy++
          else other++
          return error
        },
      ),
    )
    for (let i = 0; i < 5000 && running + busy + other < 3; i++) await Bun.sleep(1)
    expect({ running, busy, other }).toEqual({ running: 2, busy: 1, other: 0 })
    gate.resolve()
    const settled = await Promise.all(calls)
    expect(settled.filter((value) => value === "done")).toHaveLength(2)
    expect(settled.filter((value) => value instanceof ExtensionRpcError && value.code === "busy")).toHaveLength(1)
    // Admission frees up as handlers settle; the next call goes through.
    expect(await ExtensionRuntime.rpc({ id: "test.srv", method: "wait" })).toBe("done")
    ExtensionRuntime.testing.setLimits(undefined)
  })

  test("drops host.emit bursts beyond the token bucket and logs an aggregated warning", async () => {
    await link("test.srv", path.join(root, "test-srv"))
    const warn = spyOn(Log.create({ service: "extension" }), "warn")
    try {
      ExtensionRuntime.testing.setLimits({ emitRatePerSecond: 5, emitBurst: 10, emitWindowMs: 50 })
      await ExtensionRuntime.instanceHooks(pluginInput())
      const host = counters().lastHost as { emit(name: string, data?: unknown): void }
      const bus = busProbe("extension.event")
      try {
        for (let i = 0; i < 15; i++) host.emit("tick", i)
        expect(bus.seen).toHaveLength(10)
        for (let i = 0; i < 5000 && !warn.mock.calls.some(([m]) => m === "extension emit rate limit dropped events"); i++)
          await Bun.sleep(1)
        const summaries = warn.mock.calls.filter(([message]) => message === "extension emit rate limit dropped events")
        expect(summaries).toEqual([
          [
            "extension emit rate limit dropped events",
            expect.objectContaining({ extension: "test.srv", dropped: 5 }),
          ],
        ])
      } finally {
        bus.stop()
        ExtensionRuntime.testing.setLimits(undefined)
      }
    } finally {
      warn.mockRestore()
    }
  })
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
    expect(ExtensionRuntime.describe("test.srv")).toEqual({
      hasService: true,
      hasInstanceHooks: true,
      runtime: "ready",
      needsRestart: false,
    })
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
    expect(ExtensionRuntime.describe("test.srv")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })

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
    expect(ExtensionRuntime.describe("test.srv")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })

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
      // The abandoned import must not have revived its entry; the independent
      // fresh generation is still importing and is now visible as loading.
      expect(ExtensionRuntime.describe("test.srv")).toEqual({
        hasService: false,
        hasInstanceHooks: false,
        runtime: "loading",
        needsRestart: false,
      })
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
      expect(ExtensionRuntime.describe("test.srv")).toEqual({
        hasService: true,
        hasInstanceHooks: true,
        runtime: "ready",
        needsRestart: false,
      })
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
    expect(ExtensionRuntime.describe("test.srv")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })
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
    expect(ExtensionRuntime.describe("test.srv")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })
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
    expect(ExtensionRuntime.describe("test.srv")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })
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
    expect(ExtensionRuntime.describe("test.srv")).toEqual({
      hasService: false,
      hasInstanceHooks: false,
      runtime: "idle",
      needsRestart: false,
    })
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
