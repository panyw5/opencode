import { describe, expect, test } from "bun:test"
import {
  createExtensionCrashReporter,
  extensionCrashStore,
  markExtensionFailure,
  notifyExtensionPageError,
  registerExtensionCrashReporter,
  safeModeFromURL,
  type ExtensionCrashStore,
} from "./safe-mode"

const STORAGE = "opencode.global.dat"
const KEY = "extension.safeMode.crashes.v1"
const slot = (name: string, key: string) => `${name}:${key}`

function fakeStore(initial?: string) {
  const data = new Map<string, string>()
  if (initial !== undefined) data.set(slot(STORAGE, KEY), initial)
  const store: ExtensionCrashStore = {
    storeGet: async (name, key) => data.get(slot(name, key)) ?? null,
    storeSet: async (name, key, value) => {
      data.set(slot(name, key), value)
    },
  }
  return { store, data }
}

const persisted = (data: Map<string, string>) => {
  const raw = data.get(slot(STORAGE, KEY))
  return raw === undefined ? undefined : (JSON.parse(raw) as unknown)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("safe mode URL resolution", () => {
  test("auto flag forces safe mode unless the URL overrides it", () => {
    expect(safeModeFromURL("", false, true)).toEqual({ disabled: true, persist: false })
    expect(safeModeFromURL("", true, true)).toEqual({ disabled: true, persist: false })
    // An explicit URL parameter always wins over the crash strikes.
    expect(safeModeFromURL("?extensions=on", true, true)).toEqual({ disabled: false, persist: true })
    expect(safeModeFromURL("?extensions=off", false, true)).toEqual({ disabled: true, persist: true })
  })
})

describe("extension crash strikes", () => {
  test("two extension-caused page errors arm auto safe mode on the third launch", async () => {
    const { store, data } = fakeStore()

    const first = createExtensionCrashReporter(store)
    await first.load()
    first.markExtensionFailure()
    await first.recordPageError()
    expect(persisted(data)).toBe(1)
    expect(first.shouldAutoSafeMode()).toBe(false)

    const second = createExtensionCrashReporter(store)
    expect(await second.load()).toBe(1)
    second.markExtensionFailure()
    await second.recordPageError()
    expect(persisted(data)).toBe(2)

    const third = createExtensionCrashReporter(store)
    expect(await third.load()).toBe(2)
    expect(third.shouldAutoSafeMode()).toBe(true)
  })

  test("page errors without an extension failure never strike", async () => {
    const { store, data } = fakeStore()
    const reporter = createExtensionCrashReporter(store)
    await reporter.load()
    await reporter.recordPageError()
    expect(persisted(data)).toBeUndefined()
    expect(reporter.count()).toBe(0)
    expect(reporter.shouldAutoSafeMode()).toBe(false)
  })

  test("a healthy startup clears persisted strikes", async () => {
    const { store, data } = fakeStore("1")
    const crashed = createExtensionCrashReporter(store)
    expect(await crashed.load()).toBe(1)
    await crashed.startupSucceeded()
    expect(persisted(data)).toBe(0)

    const next = createExtensionCrashReporter(store)
    expect(await next.load()).toBe(0)
    expect(next.shouldAutoSafeMode()).toBe(false)
  })

  test("re-enable clears strikes and the launch flag", async () => {
    const { store, data } = fakeStore("2")
    const reporter = createExtensionCrashReporter(store)
    expect(await reporter.load()).toBe(2)
    expect(reporter.shouldAutoSafeMode()).toBe(true)

    await reporter.reset()
    expect(persisted(data)).toBe(0)
    expect(reporter.shouldAutoSafeMode()).toBe(false)

    // The launch flag is cleared too: a later page error is not attributed.
    await reporter.recordPageError()
    expect(persisted(data)).toBe(0)
  })

  test("counts in memory when no desktop store bridge exists", async () => {
    const reporter = createExtensionCrashReporter(undefined)
    reporter.markExtensionFailure()
    await reporter.recordPageError()
    expect(reporter.count()).toBe(1)
    const next = createExtensionCrashReporter(undefined)
    expect(await next.load()).toBe(0)
  })

  test("unreadable persisted values degrade to zero strikes", async () => {
    const { store } = fakeStore("not json{")
    const reporter = createExtensionCrashReporter(store)
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(await reporter.load()).toBe(0)
      expect(reporter.shouldAutoSafeMode()).toBe(false)
    } finally {
      console.warn = warn
    }
  })

  test("module hooks delegate to the registered reporter and detach cleanly", async () => {
    const { store, data } = fakeStore()
    const reporter = createExtensionCrashReporter(store)
    const off = registerExtensionCrashReporter(reporter)
    try {
      markExtensionFailure()
      notifyExtensionPageError()
      await flush()
      expect(persisted(data)).toBe(1)
    } finally {
      off()
    }
    notifyExtensionPageError()
    await flush()
    expect(persisted(data)).toBe(1)
  })
})

describe("extension crash store detection", () => {
  test("resolves the window.api bridge and degrades without it", () => {
    const calls: string[] = []
    const store = extensionCrashStore({
      api: {
        storeGet: async (name, key) => {
          calls.push(`get:${name}:${key}`)
          return null
        },
        storeSet: async (name, key, value) => {
          calls.push(`set:${name}:${key}=${value}`)
        },
      },
    })
    expect(store).toBeDefined()
    expect(extensionCrashStore({ api: {} })).toBeUndefined()
    expect(extensionCrashStore({})).toBeUndefined()
    expect(extensionCrashStore(undefined)).toBeUndefined()
  })
})
