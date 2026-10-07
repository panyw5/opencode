import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { extensionPackage } from "./fixture"
import { ExtensionID } from "../../src/extension/schema"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionManifest, type Loaded } from "../../src/extension/manifest"
import {
  createWatcher,
  resetForTesting,
  serverFingerprint,
  start,
  type SubscribeFn,
  type Target,
  type WatchCallback,
} from "../../src/extension/watch"

const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-watch-suite-"))

afterAll(() => rm(root, { recursive: true, force: true }))
afterEach(() => resetForTesting())

type FakeWatcher = {
  callbacks: Map<string, WatchCallback>
  unsubscribed: string[]
  subscribe: SubscribeFn
  emit: (dir: string, error?: Error | null) => void
}

function fakeWatcher(): FakeWatcher {
  const callbacks = new Map<string, WatchCallback>()
  const unsubscribed: string[] = []
  const subscribe: SubscribeFn = async (dir, callback) => {
    callbacks.set(dir, callback)
    return {
      unsubscribe: async () => {
        callbacks.delete(dir)
        unsubscribed.push(dir)
      },
    }
  }
  return {
    callbacks,
    unsubscribed,
    subscribe,
    emit: (dir, error = null) => callbacks.get(dir)?.(error, [{ type: "update", path: path.join(dir, "x") }]),
  }
}

function target(dir: string, id = "test.extension"): Target {
  return { id: ExtensionID.make(id), dir }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function recorder() {
  return {
    changed: [] as Array<[string, string]>,
    errors: [] as Array<[string, string, string]>,
    server: [] as string[],
    order: [] as string[],
  }
}

async function writePackage(dir: string, mutate: (json: Record<string, any>) => void) {
  const file = path.join(dir, "package.json")
  const json = await Bun.file(file).json()
  mutate(json)
  await Bun.write(file, JSON.stringify(json, null, 2))
}

describe("extension watcher", () => {
  test("publishes changed for web-only changes without touching the server runtime", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    const log = recorder()
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe: fake.subscribe,
      publishChanged: (id, version) => log.changed.push([id, version]),
      publishError: (id, version, error) => log.errors.push([id, version, message(error)]),
      onServerChange: async (id) => log.server.push(id),
    })

    await watcher.refresh()
    expect(log.changed).toEqual([])
    expect(log.server).toEqual([])

    await Bun.write(path.join(extension, "dist/web/index.js"), "export default 1\n")
    fake.emit(extension)
    await watcher.idle()

    expect(log.changed).toEqual([["test.extension", "1.2.3"]])
    expect(log.server).toEqual([])
    expect(log.errors).toEqual([])
    await watcher.stop()
  })

  test("invalidates instances before reloading the runtime for server-only changes", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    const log = recorder()
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe: fake.subscribe,
      publishChanged: (id, version) => log.changed.push([id, version]),
      publishError: (id, version, error) => log.errors.push([id, version, message(error)]),
      invalidateInstances: async () => log.order.push("invalidate"),
      reloadExtension: async (id) => log.order.push(`reload:${id}`),
    })

    await watcher.refresh()
    await Bun.write(path.join(extension, "dist/server.js"), "export const server = 1\n")
    fake.emit(extension)
    await watcher.idle()

    expect(log.order).toEqual(["invalidate", "reload:test.extension"])
    expect(log.changed).toEqual([])
    expect(log.errors).toEqual([])
    await watcher.stop()
  })

  test("keeps the old runtime and publishes an error when the new manifest fails to load", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    const log = recorder()
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe: fake.subscribe,
      publishChanged: (id, version) => log.changed.push([id, version]),
      publishError: (id, version, error) => log.errors.push([id, version, message(error)]),
      onServerChange: async (id) => log.server.push(id),
    })

    await watcher.refresh()
    await Bun.write(path.join(extension, "package.json"), "{}")
    fake.emit(extension)
    await watcher.idle()

    expect(log.errors).toHaveLength(1)
    expect(log.errors[0]?.[0]).toBe("test.extension")
    expect(log.errors[0]?.[1]).toBe("1.2.3")
    expect(log.errors[0]?.[2]).toContain("missing")
    expect(log.server).toEqual([])
    expect(log.changed).toEqual([])

    // Recovery: a loadable package resumes normal change handling.
    await extensionPackage(tmp.path, { version: "1.2.4" })
    fake.emit(extension)
    await watcher.idle()
    expect(log.changed).toEqual([["test.extension", "1.2.4"]])
    expect(log.errors).toHaveLength(1)
    await watcher.stop()
  })

  test("publishes an error when the linked id changes and keeps the old runtime", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    const log = recorder()
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe: fake.subscribe,
      publishChanged: (id, version) => log.changed.push([id, version]),
      publishError: (id, version, error) => log.errors.push([id, version, message(error)]),
      onServerChange: async (id) => log.server.push(id),
    })

    await watcher.refresh()
    await writePackage(extension, (json) => {
      json.opencode.id = "test.other"
    })
    fake.emit(extension)
    await watcher.idle()

    expect(log.errors).toHaveLength(1)
    expect(log.errors[0]?.[2]).toContain("id changed")
    expect(log.server).toEqual([])
    expect(log.changed).toEqual([])
    await watcher.stop()
  })

  test("retries a failed server reload on the next change", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    const log = recorder()
    let attempts = 0
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe: fake.subscribe,
      publishChanged: (id, version) => log.changed.push([id, version]),
      publishError: (id, version, error) => log.errors.push([id, version, message(error)]),
      onServerChange: async (id) => {
        attempts++
        if (attempts === 1) throw new Error("reload boom")
        log.server.push(id)
      },
    })

    await watcher.refresh()
    await Bun.write(path.join(extension, "dist/server.js"), "one\n")
    fake.emit(extension)
    await watcher.idle()
    expect(attempts).toBe(1)
    expect(log.errors).toEqual([["test.extension", "1.2.3", "reload boom"]])

    await Bun.write(path.join(extension, "dist/server.js"), "two\n")
    fake.emit(extension)
    await watcher.idle()
    expect(attempts).toBe(2)
    expect(log.server).toEqual(["test.extension"])
    expect(log.errors).toHaveLength(1)
    await watcher.stop()
  })

  test("coalesces event bursts into one debounced re-fingerprint", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    let loads = 0
    const load = async (dir: string): Promise<Loaded> => {
      loads++
      return ExtensionManifest.load(dir)
    }
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe: fake.subscribe,
      load,
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    await watcher.refresh()
    expect(loads).toBe(1)
    fake.emit(extension)
    fake.emit(extension)
    fake.emit(extension)
    await watcher.idle()
    expect(loads).toBe(2)
    await watcher.stop()
  })

  test("drops the subscription when the extension is unlinked or disabled", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    let enabled: Target[] = [target(extension)]
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => enabled,
      subscribe: fake.subscribe,
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    await watcher.refresh()
    enabled = []
    fake.emit(extension)
    await watcher.idle()
    expect(fake.unsubscribed).toEqual([extension])
    expect(fake.callbacks.size).toBe(0)
    await watcher.stop()
  })

  test("refresh subscribes newly linked directories and drops removed ones", async () => {
    await using tmp = await tmpdir()
    const first = await extensionPackage(tmp.path, { id: "test.first" })
    const second = await extensionPackage(tmp.path, { id: "test.second" })
    const fake = fakeWatcher()
    let enabled: Target[] = [target(first, "test.first")]
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => enabled,
      subscribe: fake.subscribe,
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    await watcher.refresh()
    expect([...fake.callbacks.keys()]).toEqual([first])

    enabled = [target(second, "test.second")]
    await watcher.refresh()
    expect([...fake.callbacks.keys()]).toEqual([second])
    expect(fake.unsubscribed).toEqual([first])
    await watcher.stop()
  })

  test("stop unsubscribes and ignores further events", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    let loads = 0
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe: fake.subscribe,
      load: async (dir) => {
        loads++
        return ExtensionManifest.load(dir)
      },
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    await watcher.refresh()
    await watcher.stop()
    expect(fake.unsubscribed).toEqual([extension])

    fake.emit(extension)
    await watcher.idle()
    expect(loads).toBe(1)
    expect(fake.callbacks.size).toBe(0)
  })

  test("serverFingerprint ignores the web root, node_modules and .git", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    await Bun.write(path.join(extension, "dist/server/index.js"), "a\n")
    await Bun.write(path.join(extension, "node_modules/dep/index.js"), "b\n")
    await Bun.write(path.join(extension, ".git/index"), "c\n")
    const webRoot = path.join(extension, "dist/web")

    const before = await serverFingerprint(extension, webRoot)
    await Bun.write(path.join(extension, "dist/web/index.js"), "changed\n")
    expect(await serverFingerprint(extension, webRoot)).toBe(before)

    await Bun.write(path.join(extension, "node_modules/dep/index.js"), "changed\n")
    expect(await serverFingerprint(extension, webRoot)).toBe(before)

    await Bun.write(path.join(extension, "dist/server/index.js"), "changed\n")
    expect(await serverFingerprint(extension, webRoot)).not.toBe(before)
  })

  test("prefers the manifest server fingerprint when the manifest carries one", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const fake = fakeWatcher()
    const log = recorder()
    let serverFingerprint = "fp-1"
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe: fake.subscribe,
      load: async (dir) => ({ ...(await ExtensionManifest.load(dir)), serverFingerprint }) as Loaded,
      publishChanged: (id, version) => log.changed.push([id, version]),
      publishError: (id, version, error) => log.errors.push([id, version, message(error)]),
      onServerChange: async (id) => log.server.push(id),
    })

    await watcher.refresh()
    serverFingerprint = "fp-2"
    fake.emit(extension)
    await watcher.idle()

    expect(log.server).toEqual(["test.extension"])
    expect(log.changed).toEqual([])
    expect(log.errors).toEqual([])
    await watcher.stop()
  })

  test("start is a singleton and resetForTesting releases it", async () => {
    const first = start({ targets: async () => [] })
    expect(start({ targets: async () => [] })).toBe(first)
    await resetForTesting()
    const second = start({ targets: async () => [] })
    expect(second).not.toBe(first)
    await second.stop()
  })

  test("start creates a new watcher after the previous one stops", async () => {
    const first = start({ targets: async () => [] })
    await first.stop()
    const second = start({ targets: async () => [] })
    expect(second).not.toBe(first)
    await second.stop()
  })

  test("watches extensions through the real registry", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const registry = path.join(root, `registry-${Math.random().toString(36).slice(2)}.json`)
    const base = () => ""
    await ExtensionRegistry.link(extension, base, registry)

    const fake = fakeWatcher()
    const log = recorder()
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () =>
        (await ExtensionRegistry.list(base, registry))
          .filter((info) => info.enabled && info.source.type === "path")
          .map((info) => ({ id: info.id, dir: info.source.path })),
      subscribe: fake.subscribe,
      publishChanged: (id, version) => log.changed.push([id, version]),
      publishError: (id, version, error) => log.errors.push([id, version, message(error)]),
      onServerChange: async (id) => log.server.push(id),
    })

    await watcher.refresh()
    expect([...fake.callbacks.keys()]).toEqual([extension])

    await Bun.write(path.join(extension, "dist/web/index.js"), "export default 2\n")
    fake.emit(extension)
    await watcher.idle()
    expect(log.changed).toEqual([["test.extension", "1.2.3"]])
    expect(log.server).toEqual([])
    await watcher.stop()
  })

  test("concurrent refreshes subscribe each directory exactly once", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const unsubscribed: string[] = []
    let calls = 0
    let entered = () => {}
    const enteredP = new Promise<void>((resolve) => (entered = resolve))
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const subscribe: SubscribeFn = async (dir) => {
      calls++
      entered()
      await gate
      return { unsubscribe: async () => unsubscribed.push(dir) }
    }
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe,
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    const refreshing = Promise.all([watcher.refresh(), watcher.refresh(), watcher.refresh()])
    await enteredP
    release()
    await refreshing

    expect(calls).toBe(1)
    await watcher.stop()
    expect(unsubscribed).toEqual([extension])
  })

  test("stop during an in-flight subscribe unwinds it exactly once", async () => {
    await using tmp = await tmpdir()
    const first = await extensionPackage(tmp.path, { id: "test.first" })
    const second = await extensionPackage(tmp.path, { id: "test.second" })
    const subscribed: string[] = []
    const unsubscribed: string[] = []
    let entered = () => {}
    const enteredP = new Promise<void>((resolve) => (entered = resolve))
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const subscribe: SubscribeFn = async (dir) => {
      subscribed.push(dir)
      if (subscribed.length === 1) {
        entered()
        await gate
      }
      return { unsubscribe: async () => unsubscribed.push(dir) }
    }
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(first, "test.first"), target(second, "test.second")],
      subscribe,
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    const refreshing = watcher.refresh()
    await enteredP
    await watcher.stop()
    release()
    await refreshing

    expect(subscribed).toEqual([first])
    expect(unsubscribed).toEqual([first])
  })

  test("stop with queued refreshes unwinds the in-flight subscribe exactly once", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    const unsubscribed: string[] = []
    let calls = 0
    let entered = () => {}
    const enteredP = new Promise<void>((resolve) => (entered = resolve))
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const subscribe: SubscribeFn = async (dir) => {
      calls++
      entered()
      await gate
      return { unsubscribe: async () => unsubscribed.push(dir) }
    }
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe,
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    const refreshing = Promise.all([watcher.refresh(), watcher.refresh()])
    await enteredP
    await watcher.stop()
    release()
    await refreshing

    expect(calls).toBe(1)
    expect(unsubscribed).toEqual([extension])
  })

  test("stop unsubscribes every established subscription exactly once", async () => {
    await using tmp = await tmpdir()
    const first = await extensionPackage(tmp.path, { id: "test.first" })
    const second = await extensionPackage(tmp.path, { id: "test.second" })
    const unsubscribed: string[] = []
    const subscribe: SubscribeFn = async (dir) => ({
      unsubscribe: async () => unsubscribed.push(dir),
    })
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(first, "test.first"), target(second, "test.second")],
      subscribe,
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    await Promise.all([watcher.refresh(), watcher.refresh()])
    await watcher.stop()
    expect([...unsubscribed].sort()).toEqual([first, second].sort())
  })

  test("retries a failed subscribe on the next refresh", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    let fail = true
    let calls = 0
    const callbacks = new Map<string, WatchCallback>()
    const subscribe: SubscribeFn = async (dir, callback) => {
      calls++
      if (fail) throw new Error("watcher boom")
      callbacks.set(dir, callback)
      return { unsubscribe: async () => callbacks.delete(dir) }
    }
    const watcher = createWatcher({
      debounceMs: 5,
      targets: async () => [target(extension)],
      subscribe,
      publishChanged: () => {},
      onServerChange: async () => {},
    })

    await watcher.refresh()
    expect(calls).toBe(1)
    expect(callbacks.has(extension)).toBe(false)

    fail = false
    await watcher.refresh()
    expect(calls).toBe(2)
    expect(callbacks.has(extension)).toBe(true)
    await watcher.stop()
  })
})
