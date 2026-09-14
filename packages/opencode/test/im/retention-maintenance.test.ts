import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Duration } from "effect"
import { IMRetention } from "../../src/im/retention"
import { IMRetentionMaintenance, type MaintenanceHandle } from "../../src/im/retention-maintenance"

type RuntimeStub = {
  cleanup: () => Effect.Effect<{ inbound: number; outbound: number }>
}

async function withRuntimeStub<A>(stub: RuntimeStub, run: () => Promise<A>) {
  const runtime = IMRetention.runtime as unknown as {
    runPromise: (fn: (service: RuntimeStub) => Effect.Effect<unknown>) => Promise<unknown>
    runFork: (fn: (service: RuntimeStub) => Effect.Effect<unknown>) => unknown
  }
  const originalPromise = runtime.runPromise
  const originalFork = runtime.runFork
  runtime.runPromise = (fn) => Effect.runPromise(fn(stub))
  runtime.runFork = (fn) => Effect.runFork(fn(stub))
  try {
    return await run()
  } finally {
    runtime.runPromise = originalPromise
    runtime.runFork = originalFork
  }
}

const policy = { channelName: "maintenance-test", retentionDays: 30 }

describe("IM retention maintenance", () => {
  test("schedules later cleanup even if initial cleanup fails", async () => {
    let calls = 0
    let recovered!: () => void
    const ready = new Promise<void>((resolve) => {
      recovered = resolve
    })
    await withRuntimeStub(
      {
        cleanup: () =>
          Effect.suspend(() => {
            calls++
            if (calls === 1) return Effect.fail(new Error("initial cleanup unavailable"))
            recovered()
            return Effect.succeed({ inbound: 0, outbound: 0 })
          }),
      },
      async () => {
        const handle = await IMRetentionMaintenance.start([policy], Duration.millis(1))
        expect(handle).toBeDefined()
        await ready
        await handle!.stop()
        expect(calls).toBeGreaterThanOrEqual(2)
      },
    )
  })
  test("does not start without policy", async () => {
    let calls = 0
    const handle = await withRuntimeStub(
      {
        cleanup: () =>
          Effect.sync(() => {
            calls++
            return { inbound: 0, outbound: 0 }
          }),
      },
      () => IMRetentionMaintenance.start([]),
    )
    expect(handle).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("runs the initial cleanup and periodic cleanup, then stops the loop", async () => {
    let calls = 0
    let secondTick!: () => void
    const second = new Promise<void>((resolve) => {
      secondTick = resolve
    })
    let handle: MaintenanceHandle | undefined
    await withRuntimeStub(
      {
        cleanup: () =>
          Effect.sync(() => {
            calls++
            if (calls === 2) secondTick()
            return { inbound: 1, outbound: 0 }
          }),
      },
      async () => {
        handle = await IMRetentionMaintenance.start([policy], Duration.millis(1))
        expect(calls).toBe(1)
        await second
        await handle!.stop()
      },
    )
    expect(handle).toBeDefined()
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test("continues after one cleanup failure and can restart with a new policy", async () => {
    let calls = 0
    let recovered!: () => void
    const recoveredSignal = new Promise<void>((resolve) => {
      recovered = resolve
    })
    let handle: MaintenanceHandle | undefined
    await withRuntimeStub(
      {
        cleanup: () =>
          Effect.suspend(() => {
            calls++
            if (calls === 3) recovered()
            return calls === 2
              ? Effect.fail(new Error("transient cleanup failure"))
              : Effect.succeed({ inbound: 0, outbound: 0 })
          }),
      },
      async () => {
        handle = await IMRetentionMaintenance.start([policy], Duration.millis(1))
        await recoveredSignal
        await handle!.stop()
      },
    )
    expect(calls).toBeGreaterThanOrEqual(3)

    let restarted = 0
    const restartedHandle = await withRuntimeStub(
      {
        cleanup: () =>
          Effect.sync(() => {
            restarted++
            return { inbound: 0, outbound: 0 }
          }),
      },
      () =>
        IMRetentionMaintenance.start([{ channelName: "maintenance-restarted", retentionDays: 7 }], Duration.days(1)),
    )
    expect(restarted).toBe(1)
    await withRuntimeStub({ cleanup: () => Effect.succeed({ inbound: 0, outbound: 0 }) }, () => restartedHandle!.stop())
  })
})
