import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import type { PluginInput } from "@opencode-ai/plugin"
import { InstanceState } from "../../src/effect/instance-state"
import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { ExtensionRuntime, type InstanceHookEntry } from "../../src/extension/runtime"
import { tmpdir } from "../fixture/fixture"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

let temp: Awaited<ReturnType<typeof tmpdir>>
let previousRegistry: string | undefined
const releases: Array<() => void> = []

function input(): PluginInput {
  return {
    directory: temp.path,
    worktree: temp.path,
    project: { id: "cache-race" },
    client: {},
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
  } as unknown as PluginInput
}

async function installFixture() {
  const dir = path.join(temp.path, "extension")
  await Bun.write(path.join(dir, "server.js"), "export default {}")
  await Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "test-cache",
      version: "1.0.0",
      type: "module",
      exports: { "./server": "./server.js" },
      opencode: { manifestVersion: 1, id: "test.cache", displayName: "Cache", activation: ["onStartup"] },
    }),
  )
  await Bun.write(
    process.env.OPENCODE_EXTENSION_REGISTRY_FILE!,
    JSON.stringify({
      version: 1,
      extensions: {
        "test.cache": {
          name: "test-cache",
          version: "1.0.0",
          source: { type: "path", path: dir },
          dir,
          enabled: true,
          installedAt: Date.now(),
        },
      },
    }),
  )
}

beforeEach(async () => {
  temp = await tmpdir()
  previousRegistry = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = path.join(temp.path, "registry.json")
  await Bun.write(process.env.OPENCODE_EXTENSION_REGISTRY_FILE, JSON.stringify({ version: 1, extensions: {} }))
  ExtensionRuntime.testing.setImporter(async () => ({
    activate: async () => ({}),
    server: async () => ({ tool: { example: { description: "cache", args: {}, execute: async () => "healthy" } } }),
  }))
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await ExtensionRuntime.testing.reset()
  if (previousRegistry === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previousRegistry
  await temp[Symbol.asyncDispose]()
})

function caches(options: { afterPlugin?: (entries: InstanceHookEntry[]) => Promise<void> } = {}) {
  return Effect.gen(function* () {
    const plugin = yield* InstanceState.make(() =>
      Effect.acquireRelease(
        Effect.promise(async () => {
          const entries = await ExtensionRuntime.instanceHooks(input())
          await options.afterPlugin?.(entries)
          return entries
        }),
        (entries) =>
          Effect.promise(async () => {
            for (const entry of entries) await entry.hooks.dispose?.()
          }),
      ),
    )
    const tool = yield* InstanceState.make(() =>
      Effect.map(InstanceState.get(plugin), (entries) => entries.map((entry) => ({ ...entry }))),
    )
    const context = { directory: temp.path, directoryKey: temp.path } as InstanceContext
    const get = () => Effect.runPromise(InstanceState.get(tool).pipe(Effect.provideService(InstanceRef, context)))
    const invalidateTool = () => Effect.runPromise(InstanceState.invalidateAll(tool))
    const invalidatePlugin = () => Effect.runPromise(InstanceState.invalidateAll(plugin))
    return { get, invalidateTool, invalidatePlugin }
  })
}

describe("real two-level InstanceState extension cache races", () => {
  test("stale invalidation before an outer initializer commits must not cache the skipped extension forever", async () => {
    await installFixture()
    const pluginReturned = deferred()
    const outerGate = deferred()
    releases.push(() => outerGate.resolve())
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let first = true
          const state = yield* caches({
            afterPlugin: async () => {
              if (!first) return
              first = false
              pluginReturned.resolve()
              await outerGate.promise
            },
          })
          const invalidated = deferred()
          const offTool = ExtensionRuntime.registerCacheInvalidator("tool", state.invalidateTool)
          const offPlugin = ExtensionRuntime.registerCacheInvalidator("plugin", async () => {
            await state.invalidatePlugin()
            invalidated.resolve()
          })
          releases.push(offTool, offPlugin)
          const release = ExtensionRuntime.beginMutation("test.cache")
          releases.push(release)
          const building = state.get()
          yield* Effect.promise(() => pluginReturned.promise)
          release()
          // The invalidator itself is the readiness signal: no scheduler sleeps.
          yield* Effect.promise(() => invalidated.promise)
          outerGate.resolve()
          yield* Effect.promise(() => building)
          const next = yield* Effect.promise(state.get)
          expect(next.map((entry) => entry.id)).toEqual(["test.cache"])
        }),
      ),
    )
  }, 5000)

  test("a Tool rebuild between tool and plugin invalidation must not retain old Plugin hooks", async () => {
    await installFixture()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* caches()
          const first = yield* Effect.promise(state.get)
          expect(first.map((entry) => entry.id)).toEqual(["test.cache"])
          const offTool = ExtensionRuntime.registerCacheInvalidator("tool", async () => {
            await state.invalidateTool()
            // Rebuild while Plugin still contains the old generation.
            await state.get()
          })
          const offPlugin = ExtensionRuntime.registerCacheInvalidator("plugin", state.invalidatePlugin)
          releases.push(offTool, offPlugin)
          yield* Effect.promise(() => ExtensionRuntime.reload("test.cache"))
          yield* Effect.promise(() => ExtensionRuntime.invalidateHooks())
          const next = yield* Effect.promise(state.get)
          expect(next[0]!.hooks).not.toBe(first[0]!.hooks)
          const value = yield* Effect.promise(() => next[0]!.hooks.tool!.example!.execute({}, {} as never))
          expect(value).toBe("healthy")
        }),
      ),
    )
  }, 5000)

  test("a first-install fence absent from the registry must expire a cache constructed during installation", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* caches()
          const offTool = ExtensionRuntime.registerCacheInvalidator("tool", state.invalidateTool)
          const offPlugin = ExtensionRuntime.registerCacheInvalidator("plugin", state.invalidatePlugin)
          releases.push(offTool, offPlugin)
          const release = ExtensionRuntime.beginMutation("test.cache")
          releases.push(release)
          // Installer pre-stop invalidation happens before a concurrent cache build.
          yield* Effect.promise(() => ExtensionRuntime.invalidateHooks())
          expect(yield* Effect.promise(state.get)).toEqual([])
          yield* Effect.promise(installFixture)
          release()
          // Observe a complete timer turn, rather than racing a release callback's
          // deferred invalidation. This is an event-loop barrier, not a timed sleep.
          const releasedTurn = deferred()
          setTimeout(() => releasedTurn.resolve(), 0)
          yield* Effect.promise(() => releasedTurn.promise)
          const next = yield* Effect.promise(state.get)
          expect(next.map((entry) => entry.id)).toEqual(["test.cache"])
        }),
      ),
    )
  }, 5000)

  test("a release arriving after Plugin invalidation schedules another complete invalidation round", async () => {
    await installFixture()
    const tailReached = deferred()
    const tailGate = deferred()
    releases.push(() => tailGate.resolve())
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const state = yield* caches()
          expect((yield* Effect.promise(state.get)).map((entry) => entry.id)).toEqual(["test.cache"])
          let tools = 0
          let plugins = 0
          const offTool = ExtensionRuntime.registerCacheInvalidator("tool", async () => {
            await state.invalidateTool()
            if (++tools === 2) {
              tailReached.resolve()
              await tailGate.promise
            }
          })
          const offPlugin = ExtensionRuntime.registerCacheInvalidator("plugin", async () => {
            plugins++
            await state.invalidatePlugin()
          })
          releases.push(offTool, offPlugin)
          const first = ExtensionRuntime.invalidateHooks()
          yield* Effect.promise(() => tailReached.promise)
          const release = ExtensionRuntime.beginMutation("test.cache")
          releases.push(release)
          expect(yield* Effect.promise(state.get)).toEqual([])
          release()
          // Let the release fallback reach the still-running old round first.
          const releasedTurn = deferred()
          setTimeout(() => releasedTurn.resolve(), 0)
          yield* Effect.promise(() => releasedTurn.promise)
          const afterRelease = ExtensionRuntime.invalidateHooks()
          tailGate.resolve()
          yield* Effect.promise(() => Promise.all([first, afterRelease]))
          const next = yield* Effect.promise(state.get)
          expect(next.map((entry) => entry.id)).toEqual(["test.cache"])
          expect(plugins).toBe(2)
          expect(tools).toBe(4)
        }),
      ),
    )
  }, 5000)
})
