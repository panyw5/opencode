import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { UpdaterState } from "../src/context/platform"
import { createUpdateNotification } from "../src/pages/layout/update-notification"

function mount(initial: Promise<UpdaterState>) {
  let listener: ((state: UpdaterState) => void) | undefined
  let unsubscribed = false
  const root = createRoot((dispose) => ({
    available: createUpdateNotification({
      getUpdaterState: () => initial,
      onUpdaterStateChanged: (next) => {
        listener = next
        return () => {
          unsubscribed = true
        }
      },
    }),
    dispose,
  }))
  return { ...root, emit: (state: UpdaterState) => listener?.(state), unsubscribed: () => unsubscribed }
}

describe("settings update notification", () => {
  test("reads an update that was ready before mounting and unsubscribes", async () => {
    const root = mount(Promise.resolve({ status: "ready", version: "2.0.0" }))
    try {
      await Promise.resolve()
      expect(root.available()).toBe(true)
    } finally {
      root.dispose()
    }
    expect(root.unsubscribed()).toBe(true)
    root.emit({ status: "idle" })
    expect(root.available()).toBe(true)
  })

  test("shows during download, pause, ready and installation; clears on cancellation or no update", async () => {
    const root = mount(Promise.resolve({ status: "idle" }))
    try {
      await Promise.resolve()
      expect(root.available()).toBe(false)
      for (const status of ["downloading", "paused", "ready", "installing"] as const) {
        root.emit({ status, version: "2.0.0" })
        expect(root.available()).toBe(true)
      }
      for (const status of ["idle", "up-to-date", "disabled"] as const) {
        root.emit({ status: "ready", version: "2.0.0" })
        root.emit({ status })
        expect(root.available()).toBe(false)
      }
    } finally {
      root.dispose()
    }
  })

  test("checking and errors do not invent or forget an available update", async () => {
    const root = mount(Promise.resolve({ status: "idle" }))
    try {
      await Promise.resolve()
      root.emit({ status: "checking" })
      root.emit({ status: "error", message: "offline" })
      expect(root.available()).toBe(false)
      root.emit({ status: "downloading", version: "2.0.0" })
      root.emit({ status: "error", message: "download interrupted" })
      root.emit({ status: "checking" })
      expect(root.available()).toBe(true)
    } finally {
      root.dispose()
    }
  })

  test("a stale initial response never overwrites a newer event", async () => {
    const { promise, resolve } = Promise.withResolvers<UpdaterState>()
    const root = mount(promise)
    try {
      root.emit({ status: "ready", version: "2.0.0" })
      resolve({ status: "idle" })
      await Promise.resolve()
      expect(root.available()).toBe(true)
    } finally {
      root.dispose()
    }
  })

  test("ignores an initial response after disposal", async () => {
    const { promise, resolve } = Promise.withResolvers<UpdaterState>()
    const root = mount(promise)
    root.dispose()
    resolve({ status: "ready", version: "2.0.0" })
    await Promise.resolve()
    expect(root.available()).toBe(false)
  })

  test("platforms without an updater never show a notification", () => {
    const root = createRoot((dispose) => ({ available: createUpdateNotification({}), dispose }))
    expect(root.available()).toBe(false)
    root.dispose()
  })
})
