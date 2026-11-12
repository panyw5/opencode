import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { makeTimerScope } from "../../src/extension/runtime/timers"

type NativeTimer = ReturnType<typeof globalThis.setTimeout>

function clock() {
  let next = 0
  const jobs = new Map<NativeTimer, () => void>()
  const cleared: NativeTimer[] = []
  const add = (callback: () => void) => {
    const handle = ++next as unknown as NativeTimer
    jobs.set(handle, callback)
    return handle
  }
  const remove = (handle: NativeTimer) => {
    cleared.push(handle)
    jobs.delete(handle)
  }
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(add as typeof globalThis.setTimeout)
  const interval = spyOn(globalThis, "setInterval").mockImplementation(add as typeof globalThis.setInterval)
  const clearTimeout = spyOn(globalThis, "clearTimeout").mockImplementation(remove as typeof globalThis.clearTimeout)
  const clearInterval = spyOn(globalThis, "clearInterval").mockImplementation(remove as typeof globalThis.clearInterval)
  return {
    jobs,
    cleared,
    timeout,
    interval,
    restore() {
      timeout.mockRestore()
      interval.mockRestore()
      clearTimeout.mockRestore()
      clearInterval.mockRestore()
    },
    first() {
      return jobs.entries().next().value!
    },
  }
}

let restore = () => {}
afterEach(() => restore())

function fixture() {
  const timer = clock()
  restore = () => timer.restore()
  let available = true
  const errors: unknown[] = []
  const pending = new Set<Promise<unknown>>()
  const tracked: Promise<unknown>[] = []
  const scope = makeTimerScope({
    available: () => available,
    track(promise) {
      tracked.push(promise)
      pending.add(promise)
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      )
      return promise
    },
    onError: (error) => errors.push(error),
  })
  return {
    timer,
    scope,
    errors,
    pending,
    tracked,
    unavailable() {
      available = false
    },
    async drain() {
      while (pending.size) await Promise.allSettled([...pending])
    },
  }
}

describe("extension timer scope", () => {
  test("timeout fires once, forwards the delay and removes its handle before invoking the callback", () => {
    const f = fixture()
    let calls = 0
    const handle = f.scope.setTimeout(() => {
      calls++
      f.scope.dispose()
    }, 37)
    const [, run] = f.timer.first()
    expect(f.timer.timeout.mock.calls[0][1]).toBe(37)
    run()
    run()
    handle.dispose()
    expect(calls).toBe(1)
    expect(f.timer.cleared).toEqual([])
    expect(f.tracked).toEqual([])
  })

  test("individual interval handles repeat, forward the delay and dispose idempotently", () => {
    const f = fixture()
    let calls = 0
    const handle = f.scope.setInterval(() => calls++, 42)
    const [id, run] = f.timer.first()
    expect(f.timer.interval.mock.calls[0][1]).toBe(42)
    run()
    run()
    handle.dispose()
    handle.dispose()
    run()
    f.scope.dispose()
    expect(calls).toBe(2)
    expect(f.timer.cleared).toEqual([id])
  })

  test("individual timeout disposal cancels an already queued callback", () => {
    const f = fixture()
    let calls = 0
    const handle = f.scope.setTimeout(() => calls++, 0)
    const [id, run] = f.timer.first()
    handle.dispose()
    handle.dispose()
    run()
    expect(calls).toBe(0)
    expect(f.timer.cleared).toEqual([id])
  })

  test("scope disposal clears all timers and suppresses queued callbacks", () => {
    const f = fixture()
    let calls = 0
    f.scope.setTimeout(() => calls++, 0)
    f.scope.setInterval(() => calls++, 0)
    const jobs = [...f.timer.jobs]
    f.scope.dispose()
    f.scope.dispose()
    for (const [, run] of jobs) run()
    expect(calls).toBe(0)
    expect(f.timer.cleared).toEqual(jobs.map(([id]) => id))
    expect(f.timer.jobs.size).toBe(0)
  })

  test("closed and unavailable scopes do not schedule new timers", () => {
    const f = fixture()
    f.unavailable()
    f.scope.setTimeout(() => {}, 0).dispose()
    f.scope.setInterval(() => {}, 0).dispose()
    f.scope.dispose()
    f.scope.setTimeout(() => {}, 0).dispose()
    f.scope.setInterval(() => {}, 0).dispose()
    expect(f.timer.timeout).not.toHaveBeenCalled()
    expect(f.timer.interval).not.toHaveBeenCalled()
  })

  test("availability is checked again immediately before invoking old-generation callbacks", () => {
    const f = fixture()
    let calls = 0
    f.scope.setTimeout(() => calls++, 0)
    f.scope.setInterval(() => calls++, 0)
    const jobs = [...f.timer.jobs]
    f.unavailable()
    for (const [, run] of jobs) run()
    expect(calls).toBe(0)
    expect(f.timer.cleared).toEqual([jobs[1][0]])
    expect(f.errors).toEqual([])
  })

  test("callback cannot recreate timers after disposing its own scope", () => {
    const f = fixture()
    f.scope.setTimeout(() => {
      f.scope.dispose()
      f.scope.setTimeout(() => {}, 0)
      f.scope.setInterval(() => {}, 0)
    }, 0)
    f.timer.first()[1]()
    expect(f.timer.timeout).toHaveBeenCalledTimes(1)
    expect(f.timer.interval).not.toHaveBeenCalled()
  })

  test.each(["setTimeout", "setInterval"] as const)("%s reports the original synchronous error once", (method) => {
    const f = fixture()
    const error = new Error("callback failed")
    f.scope[method](() => {
      throw error
    }, 0)
    const [, run] = f.timer.first()
    expect(() => run()).not.toThrow()
    run()
    expect(f.errors).toEqual([error])
    expect(f.tracked).toEqual([])
    expect(f.timer.cleared).toHaveLength(method === "setInterval" ? 1 : 0)
  })

  test.each(["setTimeout", "setInterval"] as const)(
    "%s tracks asynchronous callback completion through disposal",
    async (method) => {
      const f = fixture()
      const done = Promise.withResolvers<void>()
      f.scope[method](() => done.promise, 0)
      f.timer.first()[1]()
      expect(f.pending.size).toBe(1)
      f.scope.dispose()
      expect(f.pending.size).toBe(1)
      done.resolve()
      await f.drain()
      expect(f.pending.size).toBe(0)
      expect(f.errors).toEqual([])
    },
  )

  test.each(["setTimeout", "setInterval"] as const)(
    "%s catches asynchronous rejection without leaking a rejected tracked promise",
    async (method) => {
      const f = fixture()
      const error = new Error("async callback failed")
      f.scope[method](async () => {
        throw error
      }, 0)
      const [, run] = f.timer.first()
      run()
      await f.drain()
      run()
      expect(f.errors).toEqual([error])
      expect(await Promise.allSettled(f.tracked)).toEqual([{ status: "fulfilled", value: undefined }])
    },
  )

  test("overlapping interval callbacks are all tracked, but only the first failure is reported", async () => {
    const f = fixture()
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const queue = [first.promise, second.promise]
    f.scope.setInterval(() => queue.shift(), 0)
    const [id, run] = f.timer.first()
    run()
    run()
    expect(f.pending.size).toBe(2)
    first.reject(new Error("first failure"))
    await f.tracked[0]
    expect(f.timer.cleared).toEqual([id])
    second.reject(new Error("second failure"))
    await f.drain()
    run()
    expect(f.errors).toHaveLength(1)
    expect((f.errors[0] as Error).message).toBe("first failure")
    expect(f.tracked).toHaveLength(2)
  })

  test("thenables are tracked and throwing then accessors are caught", async () => {
    const f = fixture()
    const error = new Error("then getter failed")
    f.scope.setTimeout(() => ({ then: (resolve: (value: string) => void) => resolve("done") }), 0)
    f.timer.first()[1]()
    await f.drain()
    expect(await f.tracked[0]).toBe("done")
    f.scope.setTimeout(
      () =>
        Object.defineProperty({}, "then", {
          get() {
            throw error
          },
        }),
      0,
    )
    ;[...f.timer.jobs.values()].at(-1)!()
    expect(f.errors).toEqual([error])
  })

  test("disposing one scope does not cancel another scope's timers", () => {
    const f = fixture()
    let calls = 0
    const other = makeTimerScope({ available: () => true, track: () => {}, onError: () => {} })
    f.scope.setTimeout(() => {}, 0)
    other.setTimeout(() => calls++, 0)
    const run = [...f.timer.jobs.values()].at(-1)!
    f.scope.dispose()
    run()
    expect(calls).toBe(1)
    other.dispose()
  })
})
