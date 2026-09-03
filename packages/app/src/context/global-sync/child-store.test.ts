import { beforeAll, describe, expect, test, mock } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import type { createChildStoreManager as createChildStoreManagerType } from "./child-store"

const child = () => createStore({} as State)

let createChildStoreManager: typeof createChildStoreManagerType

beforeAll(async () => {
  mock.module("@/utils/persist", () => ({
    Persist: {
      workspace: (directory: string, key: string) => `${directory}:${key}`,
    },
    persisted: (_: string, store: [unknown, unknown]) => [store[0], store[1], null, () => true],
  }))

  const mod = await import("./child-store")
  createChildStoreManager = mod.createChildStoreManager
})

describe("createChildStoreManager", () => {
  test("seeds the directory before bootstrap completes", () => {
    createRoot((dispose) => {
      const owner = getOwner()
      if (!owner) throw new Error("owner required")

      const manager = createChildStoreManager({
        owner,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onDispose() {},
        translate: (key) => key,
      })

      const [store] = manager.child("/active", { bootstrap: false })

      expect(store.path.directory).toBe("/active")
      dispose()
    })
  })

  test("does not evict the active directory during mark", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onDispose() {},
      translate: (key) => key,
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })

  // Characterization tests for the directory lifecycle coupling described in
  // specs/v2/location-lifecycle.md: renderer eviction drives backend teardown
  // and a disposed directory silently revives on next access. Update these
  // when the frontend decoupling PR lands.
  test("disposeDirectory drives the backend teardown callback", () => {
    createRoot((dispose) => {
      const owner = getOwner()
      if (!owner) throw new Error("owner required")

      const disposed: string[] = []
      const manager = createChildStoreManager({
        owner,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onDispose(directory) {
          disposed.push(directory)
        },
        translate: (key) => key,
      })

      manager.child("/gone", { bootstrap: false })
      expect(manager.disposeDirectory("/gone")).toBe(true)
      expect(disposed).toEqual(["/gone"])
      expect(manager.children["/gone"]).toBeUndefined()
      dispose()
    })
  })

  test("child() re-bootstraps a directory after dispose", () => {
    createRoot((dispose) => {
      const owner = getOwner()
      if (!owner) throw new Error("owner required")

      const bootstrapped: string[] = []
      const manager = createChildStoreManager({
        owner,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstrapped.push(directory)
        },
        onDispose() {},
        translate: (key) => key,
      })

      manager.child("/revive")
      expect(manager.disposeDirectory("/revive")).toBe(true)
      manager.child("/revive")

      expect(bootstrapped).toEqual(["/revive", "/revive"])
      expect(manager.children["/revive"]).toBeDefined()
      dispose()
    })
  })

  test("does not leak a dispose callback failure into the active directory", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    let disposed = 0
    const manager = createChildStoreManager({
      owner,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onDispose() {
        disposed++
        throw new Error("server unavailable")
      },
      translate: (key) => key,
    })

    Array.from({ length: 30 }, (_, index) => `/idle-${index}`).forEach((directory) => {
      manager.children[directory] = child()
    })
    manager.children["/active"] = child()

    const warn = console.warn
    console.warn = mock(() => {})
    try {
      expect(() => manager.mark("/active")).not.toThrow()
      expect(disposed).toBe(30)
      expect(manager.children["/active"]).toBeDefined()
    } finally {
      console.warn = warn
    }
  })
})
