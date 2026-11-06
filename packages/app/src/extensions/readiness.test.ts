import { describe, expect, test } from "bun:test"
import { createExtensionReadiness, type ExtensionReadinessScope } from "./readiness"

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function setup(input: Partial<ExtensionReadinessScope<object>> = {}) {
  let scope: ExtensionReadinessScope<object> = {
    url: "http://a:4096",
    client: {},
    safeReady: true,
    disabled: false,
    ...input,
  }
  let changes = 0
  const readiness = createExtensionReadiness(
    () => scope,
    () => changes++,
  )
  return {
    readiness,
    changes: () => changes,
    update(next: Partial<ExtensionReadinessScope<object>>) {
      scope = { ...scope, ...next }
    },
  }
}

async function pending(promise: Promise<void>) {
  let settled = false
  void promise.then(() => (settled = true))
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
}

describe("extension first-manifest readiness", () => {
  test("is false and pending until the first attempt settles, including failure", async () => {
    const { readiness } = setup()
    expect(readiness.ready()).toBe(false)
    const waiting = readiness.whenReady()
    await pending(waiting)
    const scope = readiness.capture()
    const list = deferred()
    // Host preserves strict rejection but settles readiness in finally.
    const strictRefresh = list.promise.finally(() => readiness.settle(scope))
    list.reject(new Error("offline"))
    await expect(strictRefresh).rejects.toThrow("offline")
    await waiting
    expect(readiness.ready()).toBe(true)
    await readiness.whenReady()
  })

  test("waits for persisted safe mode before allowing settlement", async () => {
    const { readiness, update } = setup({ safeReady: false })
    const beforeSafeMode = readiness.capture()
    const waiting = readiness.whenReady()
    readiness.settle(beforeSafeMode)
    expect(readiness.ready()).toBe(false)
    await pending(waiting)
    update({ safeReady: true })
    const current = readiness.capture()
    readiness.settle(beforeSafeMode)
    expect(readiness.ready()).toBe(false)
    readiness.settle(current)
    await waiting
    expect(readiness.ready()).toBe(true)
  })

  test("disabled scope settles without a list and re-enabling needs a fresh list", async () => {
    const { readiness, update } = setup({ disabled: true })
    const disabled = readiness.capture()
    const waiting = readiness.whenReady()
    expect(readiness.ready()).toBe(false)
    readiness.settle(disabled)
    await waiting
    expect(readiness.ready()).toBe(true)
    update({ disabled: false })
    expect(readiness.ready()).toBe(false)
    const enabledWaiting = readiness.whenReady()
    readiness.settle(disabled)
    await pending(enabledWaiting)
    readiness.settle(readiness.capture())
    await enabledWaiting
  })

  for (const change of ["url", "client"] as const) {
    test(`${change} changes invalidate an already-ready scope synchronously`, async () => {
      const { readiness, update } = setup()
      const old = readiness.capture()
      readiness.settle(old)
      expect(readiness.ready()).toBe(true)
      update(change === "url" ? { url: "http://b:4096" } : { client: {} })
      expect(readiness.ready()).toBe(false)
      const waiting = readiness.whenReady()
      readiness.settle(old)
      expect(readiness.isCurrent(old)).toBe(false)
      await pending(waiting)
      readiness.settle(readiness.capture())
      await waiting
      expect(readiness.ready()).toBe(true)
    })

    test(`old asynchronous settlement cannot resolve a pending new ${change} scope`, async () => {
      const { readiness, update } = setup()
      const old = readiness.capture()
      const oldList = deferred()
      const oldRefresh = oldList.promise.finally(() => readiness.settle(old))
      const oldWaiting = readiness.whenReady()
      update(change === "url" ? { url: "http://b:4096" } : { client: {} })
      const current = readiness.capture()
      const newWaiting = readiness.whenReady()
      oldList.resolve()
      await oldRefresh
      expect(readiness.ready()).toBe(false)
      await pending(oldWaiting)
      await pending(newWaiting)
      readiness.settle(current)
      await Promise.all([oldWaiting, newWaiting])
      expect(readiness.ready()).toBe(true)
    })
  }

  test("A-B-A reconnect cannot reuse A's earlier readiness or in-flight scope", async () => {
    const { readiness, update } = setup()
    const firstA = readiness.capture()
    readiness.settle(firstA)
    update({ url: "http://b:4096", client: {} })
    const b = readiness.capture()
    update({ url: firstA.url, client: {} })
    expect(readiness.ready()).toBe(false)
    const waiting = readiness.whenReady()
    readiness.settle(firstA)
    readiness.settle(b)
    await pending(waiting)
    readiness.settle(readiness.capture())
    await waiting
  })

  test("a failed stale request leaves current waiters pending", async () => {
    const { readiness, update } = setup()
    const old = readiness.capture()
    const list = deferred()
    const refresh = list.promise.finally(() => readiness.settle(old))
    update({ client: {} })
    const waiting = readiness.whenReady()
    list.reject(new Error("old connection failed"))
    await expect(refresh).rejects.toThrow("old connection failed")
    await pending(waiting)
    readiness.settle(readiness.capture())
    await waiting
  })

  test("settles only once and stable reads do not emit state changes", () => {
    const { readiness, changes } = setup()
    const scope = readiness.capture()
    expect(changes()).toBe(1)
    expect(readiness.capture()).toBe(scope)
    readiness.ready()
    expect(changes()).toBe(1)
    readiness.settle(scope)
    readiness.settle(scope)
    readiness.ready()
    expect(changes()).toBe(2)
  })

  test("disposal releases waiters without marking the host ready", async () => {
    const { readiness } = setup()
    const scope = readiness.capture()
    const waiting = readiness.whenReady()
    readiness.dispose()
    await waiting
    readiness.settle(scope)
    expect(readiness.ready()).toBe(false)
    expect(readiness.isCurrent(scope)).toBe(false)
  })
})
