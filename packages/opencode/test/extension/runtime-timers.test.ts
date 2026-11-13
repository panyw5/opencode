import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ExtensionHooks, ExtensionHost, ExtensionService } from "@opencode-ai/extension-kit/server"
import { ExtensionRuntime, type Options } from "../../src/extension/runtime"
import { ExtensionRegistry } from "../../src/extension/registry"
import { extensionPackage } from "./fixture"
import { tmpdir } from "../fixture/fixture"

let options: Options
let rt: ReturnType<typeof ExtensionRuntime.make>

let temp: Awaited<ReturnType<typeof tmpdir>>
let previous: string | undefined
const owned: ExtensionHooks[] = []
const releases: Array<() => void> = []
let id = ""
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function input(name: string): PluginInput {
  return {
    directory: path.join(temp.path, name),
    worktree: temp.path,
    project: {},
    client: {},
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost:4096"),
  } as unknown as PluginInput
}
async function load(name: string) {
  const entries = await rt.instanceHooks(input(name))
  owned.push(...entries.map((entry) => entry.hooks))
  return entries
}
beforeEach(async () => {
    options = {}
    rt = ExtensionRuntime.make(options)
  temp = await tmpdir()
  previous = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = path.join(temp.path, "registry.json")
  id = `test.timer-${crypto.randomUUID()}`
  const dir = await extensionPackage(temp.path, {
    id,
    serverEntry: "dist/server.js",
    webExport: null,
    webManifest: false,
    fileViewers: null,
    activation: null,
  })
  await ExtensionRegistry.link(dir)
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const hooks of owned.splice(0)) await hooks.dispose?.()
  await rt.testing.reset()
  if (previous === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previous
  await temp[Symbol.asyncDispose]()
})

test("instance timers stop with their hooks without clearing the process or sibling timers", async () => {
  const processTick = deferred()
  const siblingTick = deferred()
  let processHost!: ExtensionHost
  let firstHost!: ExtensionHost
  options.importer = (async () => ({
    id,
    activate: async (host) => {
      processHost = host
      return {}
    },
    server: async (value) => {
      if (value.directory.endsWith("one")) firstHost = value.extension
      else value.extension.setTimeout(() => siblingTick.resolve(), 20)
      return {}
    },
  }))
  const [first] = await load("one")
  await load("two")
  processHost.setTimeout(() => processTick.resolve(), 20)
  let cancelled = 0
  firstHost.setTimeout(() => {
    cancelled++
  }, 0)
  await first!.hooks.dispose!()
  await Promise.all([processTick.promise, siblingTick.promise])
  expect(cancelled).toBe(0)
})

test.each(["disable", "reload", "quiesce"] as const)(
  "%s clears all owned timers even without custom disposal",
  async (action) => {
    let ticks = 0
    let host!: ExtensionHost
    options.importer = (async () => ({
      id,
      activate: async (value) => {
        host = value
        return {}
      },
    }))
    await rt.rpc({ id, method: "missing" }).catch(() => {})
    host.setTimeout(() => {
      ticks++
    }, 0)
    await rt[action](id)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(ticks).toBe(0)
    host.setTimeout(() => {
      ticks++
    }, 0)
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(ticks).toBe(0)
  },
)

test("activation failure revokes timers before their first tick", async () => {
  let ticks = 0
  options.importer = (async () => ({
    id,
    activate: async (host) => {
      host.setTimeout(() => {
        ticks++
      }, 0)
      throw new Error("activation failed")
    },
  }))
  await rt.rpc({ id, method: "missing" }).catch(() => {})
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  expect(ticks).toBe(0)
  expect(rt.describe(id).runtime).toBe("error")
})

test("a timed-out activation cannot schedule more timers through a retained host", async () => {
  const gate = deferred<ExtensionService>()
  releases.push(() => gate.resolve({}))
  let host!: ExtensionHost
  let ticks = 0
  Object.assign(options, { activateMs: 30 })
  options.importer = (async () => ({
    id,
    activate: async (value) => {
      host = value
      return gate.promise
    },
  }))
  await load("late")
  host.setTimeout(() => {
    ticks++
  }, 0)
  gate.resolve({})
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  expect(ticks).toBe(0)
})

test("timer promises remain tracked after disposal until quiesce drains them", async () => {
  const started = deferred()
  const gate = deferred()
  releases.push(() => gate.resolve())
  options.importer = (async () => ({
    id,
    activate: async (host) => {
      host.setTimeout(async () => {
        started.resolve()
        await gate.promise
      }, 0)
      return {}
    },
  }))
  await rt.rpc({ id, method: "missing" }).catch(() => {})
  await started.promise
  let stopped = false
  const stopping = rt.quiesce(id, { timeoutMs: 1000 }).then((result) => {
    stopped = true
    return result
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  gate.resolve()
  expect(await stopping).toEqual({ stopped: true, needsRestart: false })
})
