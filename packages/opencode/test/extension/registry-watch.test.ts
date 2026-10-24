import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createRegistryObserver,
  type RegistryObserver,
  type RegistryWatch,
  type RegistryWatchHandle,
} from "../../src/extension/registry-watch"

const observers: RegistryObserver[] = []
const directories: string[] = []

afterEach(async () => {
  await Promise.all(observers.splice(0).map((observer) => observer.stop()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "registry-observer-"))
  directories.push(directory)
  return { directory, file: path.join(directory, "registry.json") }
}

function observer(options: Parameters<typeof createRegistryObserver>[0]) {
  const result = createRegistryObserver(options)
  observers.push(result)
  return result
}

async function put(file: string, revision: number, version = 2) {
  await writeFile(file, JSON.stringify({ version, revision, extensions: {} }))
}

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Observer condition timed out")
    await Bun.sleep(5)
  }
}

function fakeWatch() {
  let callback: Parameters<RegistryWatch>[1] | undefined
  let error: ((error: Error) => void) | undefined
  let closed = 0
  let attached = 0
  let unrefed = 0
  const watch: RegistryWatch = (_directory, listener) => {
    attached++
    callback = listener
    return {
      close() {
        closed++
      },
      unref() {
        unrefed++
      },
      on(_event, listener) {
        error = listener
      },
    }
  }
  return {
    watch,
    emit: () => callback?.("rename", null),
    fail: () => error?.(new Error("watch failed")),
    get closed() {
      return closed
    },
    get attached() {
      return attached
    },
    get unrefed() {
      return unrefed
    },
  }
}

describe("registry observer", () => {
  test("starts with a baseline; manual refresh delivers it once without writing the registry", async () => {
    const { file, directory } = await fixture()
    await put(file, 4)
    const original = await readFile(file, "utf8")
    const calls: string[] = []
    const fake = fakeWatch()
    const instance = observer({
      file,
      refresh: async (revision) => {
        calls.push(revision)
      },
      watch: fake.watch,
    })
    await Promise.all([instance.start(), instance.start()])
    expect(calls).toEqual([])
    expect(fake.attached).toBe(1)
    expect(fake.unrefed).toBe(1)
    await instance.refresh()
    await instance.refresh()
    expect(calls).toEqual(["v2:4"])
    await put(file, 5)
    await instance.refresh()
    expect(calls).toEqual(["v2:4", "v2:5"])
    await put(file, 4)
    expect(await readFile(file, "utf8")).toBe(original)
    expect(await readdir(directory)).toEqual(["registry.json"])
  })

  test("v3 tokens include format version even when the numeric revision is unchanged", async () => {
    const { file, directory } = await fixture()
    await put(file, 4)
    const calls: string[] = []
    const instance = observer({
      file,
      watch: fakeWatch().watch,
      refresh: async (revision) => {
        calls.push(revision)
      },
    })
    await instance.start()
    await instance.refresh()
    await put(file, 4, 3)
    await instance.refresh()
    await instance.refresh()
    await put(file, 5, 3)
    await instance.refresh()
    expect(calls).toEqual(["v2:4", "v3:4", "v3:5"])
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3)
    expect(await readdir(directory)).toEqual(["registry.json"])
  })

  test("v3 polling retries failed refreshes and rejects invalid versions and revisions", async () => {
    const { file } = await fixture()
    await put(file, 0, 3)
    const calls: string[] = []
    const errors: unknown[] = []
    let fail = true
    const instance = observer({
      file,
      watch: fakeWatch().watch,
      intervalMs: 10,
      refresh: async (revision) => {
        if (fail) {
          fail = false
          throw new Error("reload failed")
        }
        calls.push(revision)
      },
      onError: (error) => errors.push(error),
    })
    await instance.start()
    await put(file, 1, 3)
    await until(() => calls.length === 1)
    for (const contents of [
      { version: 4, revision: 2 },
      { version: 3, revision: -1 },
      { version: 3, revision: 0.5 },
      { version: 3, revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const text = JSON.stringify({ ...contents, extensions: {} })
      await writeFile(file, text)
      await expect(instance.refresh()).rejects.toThrow("version or revision")
      expect(await readFile(file, "utf8")).toBe(text)
    }
    await put(file, 2, 3)
    await until(() => calls.length === 2)
    expect(calls).toEqual(["v3:1", "v3:2"])
    expect(errors.length).toBeGreaterThanOrEqual(5)
  })

  test("native directory watching survives repeated atomic rename replacements", async () => {
    const { file, directory } = await fixture()
    await put(file, 0)
    const calls: string[] = []
    const instance = observer({
      file,
      intervalMs: 60_000,
      debounceMs: 5,
      refresh: async (revision) => {
        calls.push(revision)
      },
    })
    await instance.start()
    for (const revision of [1, 2]) {
      const temporary = path.join(directory, `registry-${revision}.tmp`)
      await put(temporary, revision)
      await rename(temporary, file)
      await until(() => calls.includes(`v2:${revision}`))
    }
    expect(calls).toEqual(["v2:1", "v2:2"])
  })

  test("polling detects a missing parent appearing and reattaches after watch errors", async () => {
    const { directory } = await fixture()
    const parent = path.join(directory, "late")
    const file = path.join(parent, "registry.json")
    const calls: string[] = []
    const errors: unknown[] = []
    const fake = fakeWatch()
    const instance = observer({
      file,
      intervalMs: 10,
      debounceMs: 1,
      watch: fake.watch,
      refresh: async (revision) => {
        calls.push(revision)
      },
      onError: (error) => {
        errors.push(error)
      },
    })
    await instance.start()
    expect(fake.attached).toBe(0)
    await mkdir(parent)
    await put(file, 1)
    await until(() => calls.length === 1)
    expect(calls).toEqual(["v2:1"])
    expect(fake.attached).toBe(1)
    fake.fail()
    await until(() => fake.attached === 2)
    expect(errors).toHaveLength(1)
    await put(file, 2)
    await until(() => calls.length === 2)
    await rm(file)
    await until(() => calls.includes("missing"))
    expect(calls).toEqual(["v2:1", "v2:2", "missing"])
  })

  test("v1 content digests catch same-size updates without migrating or backing up", async () => {
    const { file, directory } = await fixture()
    const original = '{"version":1,"extensions":{"a":1}}'
    await writeFile(file, original)
    const calls: string[] = []
    const instance = observer({
      file,
      watch: fakeWatch().watch,
      refresh: async (revision) => {
        calls.push(revision)
      },
    })
    await instance.refresh()
    const changed = original.replace('"a":1', '"a":2')
    await writeFile(file, changed)
    await instance.refresh()
    await instance.refresh()
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatch(/^v1:[a-f0-9]{64}$/)
    expect(calls[0]).not.toBe(calls[1])
    expect(await readFile(file, "utf8")).toBe(changed)
    expect(await readdir(directory)).toEqual(["registry.json"])
  })

  test("serializes refreshes and does not lose events arriving during an in-flight callback", async () => {
    const { file } = await fixture()
    await put(file, 0)
    const fake = fakeWatch()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const calls: string[] = []
    const finished: string[] = []
    const instance = observer({
      file,
      watch: fake.watch,
      intervalMs: 60_000,
      debounceMs: 1,
      refresh: async (revision) => {
        calls.push(revision)
        if (revision === "v2:1") {
          entered.resolve()
          await release.promise
        }
        finished.push(revision)
      },
    })
    await instance.start()
    await put(file, 1)
    fake.emit()
    await entered.promise
    await put(file, 2)
    for (let i = 0; i < 10; i++) fake.emit()
    await Bun.sleep(10)
    expect(calls).toEqual(["v2:1"])
    release.resolve()
    await until(() => finished.length === 2)
    await instance.refresh()
    expect(calls).toEqual(["v2:1", "v2:2"])
    expect(finished).toEqual(calls)
  })

  test("retries failed callbacks and invalid JSON without advancing the delivered token", async () => {
    const { file } = await fixture()
    await put(file, 0)
    let attempts = 0
    const calls: string[] = []
    const errors: unknown[] = []
    const instance = observer({
      file,
      watch: fakeWatch().watch,
      intervalMs: 10,
      refresh: async (revision) => {
        attempts++
        if (attempts === 1) throw new Error("reload failed")
        calls.push(revision)
      },
      onError: (error) => {
        errors.push(error)
      },
    })
    await instance.start()
    await put(file, 1)
    await until(() => calls.length === 1)
    expect(attempts).toBe(2)
    await writeFile(file, "invalid")
    await expect(instance.refresh()).rejects.toThrow()
    await put(file, 2)
    await until(() => calls.length === 2)
    expect(calls).toEqual(["v2:1", "v2:2"])
    expect(errors.length).toBeGreaterThanOrEqual(2)
  })

  test("stop waits for a late asynchronous watch attachment and closes its handle", async () => {
    const { file } = await fixture()
    await put(file, 0)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<RegistryWatchHandle>()
    let closed = 0
    let stopped = false
    const instance = observer({
      file,
      refresh: async () => {
        throw new Error("unexpected refresh")
      },
      watch: () => {
        entered.resolve()
        return release.promise
      },
    })
    const starting = instance.start()
    await entered.promise
    const stopping = instance.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(5)
    expect(stopped).toBe(false)
    release.resolve({
      close() {
        closed++
      },
    })
    await Promise.all([starting, stopping])
    expect(closed).toBe(1)
    await instance.start()
    await instance.refresh()
  })

  test("stop awaits in-flight refresh, cancels pending timers and ignores late callbacks", async () => {
    const { file } = await fixture()
    await put(file, 0)
    const fake = fakeWatch()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    let stopped = false
    const instance = observer({
      file,
      watch: fake.watch,
      intervalMs: 10,
      debounceMs: 10,
      refresh: async () => {
        calls++
        entered.resolve()
        await release.promise
      },
    })
    await instance.start()
    await put(file, 1)
    const refreshing = instance.refresh()
    await entered.promise
    fake.emit()
    const stopping = instance.stop().then(() => {
      stopped = true
    })
    await Bun.sleep(20)
    expect(stopped).toBe(false)
    release.resolve()
    await Promise.all([refreshing, stopping])
    await put(file, 2)
    fake.emit()
    fake.fail()
    await instance.refresh()
    await Bun.sleep(30)
    expect(calls).toBe(1)
    expect(fake.closed).toBe(1)
  })
})
