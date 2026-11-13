import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HostProcessSupervisor, type SpawnInput } from "../../../src/extension/host-process/supervisor.ts"
import { HostProcessError } from "../../../src/extension/host-process/protocol.ts"
import { testEffect } from "../../lib/effect.ts"
import { outcome, pidAlive, testFence, testLimits, trace, workerFixture } from "./fixture.ts"

const it = testEffect(HostProcessSupervisor.layer)

const executable = Bun.which("bun") ?? Bun.which("node")
const run = executable && process.platform !== "win32" ? it.live : it.live.skip

function input(over: Partial<SpawnInput> = {}): SpawnInput {
  const fence = testFence()
  return {
    extension: "fixture-ext",
    fence,
    executable: executable!,
    args: (identity) => [workerFixture, JSON.stringify(identity), "normal"],
    limits: testLimits({ readinessMs: 10_000, drainMs: 200, disposeMs: 500, exitMs: 5_000 }),
    hooks: { init: { entry: "/ext/fixture" } },
    ...over,
  }
}

describe("HostProcessSupervisor", () => {
  run("spawns a worker through the service and scope release stops it", () =>
    Effect.gen(function* () {
      const supervisor = yield* HostProcessSupervisor
      const events = trace()
      let pid: number | undefined
      let stopped: string | undefined
      yield* Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* supervisor.spawn(
            input({ hooks: { init: { entry: "/ext" }, report: events.report } }),
          )
          yield* Effect.promise(() => worker.ready())
          pid = worker.info().pid
          expect(pidAlive(pid)).toBe(true)
          expect(yield* Effect.promise(() => worker.request("echo", { a: 1 }))).toEqual({ a: 1 })
          stopped = (yield* Effect.promise(() => worker.stop())).status
        }),
      )
      expect(stopped).toBe("rootExited")
      expect(pidAlive(pid)).toBe(false)
    }),
    30_000,
  )

  run("a crash restarts the worker under the backoff skeleton with a fresh runtime fence", () =>
    Effect.gen(function* () {
      const supervisor = yield* HostProcessSupervisor
      const events = trace()
      const readies: number[] = []
      const crashes: number[] = []
      const worker = yield* supervisor.spawn(
        input({
          limits: testLimits({ restartBackoffMs: [20, 20, 20] }),
          hooks: {
            init: null,
            report: events.report,
            onReady: () => readies.push(Date.now()),
            onCrash: () => crashes.push(Date.now()),
          },
        }),
      )
      yield* Effect.promise(() => worker.ready())
      const first = worker.info().identity
      expect(first.runtime).toBeDefined()
      const request = outcome(worker.request("crash", null))
      expect(yield* Effect.promise(() => request)).toMatchObject({ code: "exited" })
      // Wait for the restarted generation to become ready again.
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 10_000
        while (readies.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      })
      expect(crashes.length).toBe(1)
      expect(readies.length).toBe(2)
      expect(worker.info().status).toBe("ready")
      expect(worker.info().crashes).toBe(1)
      expect(worker.info().identity.runtime).not.toBe(first.runtime)
      expect(yield* Effect.promise(() => worker.request("echo", "again"))).toBe("again")
      expect((yield* Effect.promise(() => worker.stop())).status).toBe("rootExited")
    }),
    30_000,
  )

  run("exhausting the backoff budget leaves the worker in error state", () =>
    Effect.gen(function* () {
      const supervisor = yield* HostProcessSupervisor
      let exhausted = 0
      const worker = yield* supervisor.spawn(
        input({
          args: (identity) => [workerFixture, JSON.stringify(identity), "loadThrow"],
          limits: testLimits({ readinessMs: 300, restartBackoffMs: [10, 10] }),
          hooks: { onExhausted: () => exhausted++ },
        }),
      )
      // readiness failure → terminate → crash → restart ×2 → error.
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 15_000
        while (worker.info().status !== "error" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      })
      expect(worker.info().status).toBe("error")
      expect(worker.info().crashes).toBe(3)
      expect(exhausted).toBe(1)
      yield* Effect.promise(() => worker.stop())
    }),
    30_000,
  )

  run("host.call and notify flow through the service hooks", () =>
    Effect.gen(function* () {
      const supervisor = yield* HostProcessSupervisor
      const notified: unknown[] = []
      const worker = yield* supervisor.spawn(
        input({
          hooks: {
            onHostCall: async (method, value) => ({ granted: method, value }),
            onNotify: (method, value) => notified.push([method, value]),
          },
        }),
      )
      yield* Effect.promise(() => worker.ready())
      expect(yield* Effect.promise(() => worker.request("ask", { q: 2 }))).toEqual({ granted: "tool.ask", value: { q: 2 } })
      expect(yield* Effect.promise(() => worker.request("emit", 7))).toBe("emitted")
      yield* Effect.promise(async () => {
        const deadline = Date.now() + 5_000
        while (notified.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
      })
      expect(notified).toEqual([["host.emit", 7]])
      expect((yield* Effect.promise(() => worker.stop())).status).toBe("rootExited")
    }),
    30_000,
  )

  run("testing.reset stops every live worker and workers() reports status", () =>
    Effect.gen(function* () {
      const supervisor = yield* HostProcessSupervisor
      const worker = yield* supervisor.spawn(input())
      yield* Effect.promise(() => worker.ready())
      const listed = yield* supervisor.workers()
      expect(listed.map((entry) => entry.extension)).toContain("fixture-ext")
      expect(listed.find((entry) => entry.extension === "fixture-ext")?.status).toBe("ready")
      yield* supervisor.testing.reset()
      expect(pidAlive(worker.info().pid)).toBe(false)
      expect(yield* supervisor.workers()).toEqual([])
    }),
    30_000,
  )

  run("spawn failure surfaces as HostProcessError without a live record", () =>
    Effect.gen(function* () {
      const supervisor = yield* HostProcessSupervisor
      const failed = yield* supervisor
        .spawn(input({ executable: `/nonexistent-host-process-${Date.now()}` }))
        .pipe(Effect.result)
      expect(failed._tag).toBe("Failure")
      if (failed._tag === "Failure") expect(failed.failure).toBeInstanceOf(HostProcessError)
      expect(yield* supervisor.workers()).toEqual([])
    }),
    30_000,
  )
})
