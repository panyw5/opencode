import { expect, test } from "bun:test"
import { spawnWorkerTransport } from "../../../src/extension/host-process/transport.ts"
import { superviseWorker } from "../../../src/extension/host-process/supervisor.ts"
import type { RuntimeIdentity } from "../../../src/extension/host-process/protocol.ts"
import { outcome, pidAlive, testIdentity, testLimits, trace, workerFixture } from "./fixture.ts"

const limits = testLimits()

for (const [runtime, executable] of [
  ["bun", Bun.which("bun")],
  ["node", Bun.which("node")],
] as const) {
  // Bun extra-fd adaptation is verified on Darwin only (Q8); the Node path is
  // kept under the same gate to run both paths on the same coverage matrix.
  const run = test.skipIf(!executable || process.platform === "win32")
  const launch = (
    identity: RuntimeIdentity,
    behavior: string,
    events: ReturnType<typeof trace>,
    env?: NodeJS.ProcessEnv,
  ) =>
    spawnWorkerTransport({
      executable: executable!,
      args: [workerFixture, JSON.stringify(identity), behavior],
      env,
      frameBytes: 64 * 1024,
      bufferedFrames: 16,
      exitMs: 10_000,
      log: (stream, text) => events.report(`${stream}: ${text}`),
    })

  run(
    `${runtime}: admitted worker completes hello/init/ready/request/dispose/exit and isolates stdout`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "normal", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits,
        hooks: { report: events.report, init: { entry: "/ext/fixture", settings: { a: 1 } } },
      })
      await supervisor.ready().catch((cause) => {
        throw new Error(events.text(), { cause })
      })
      expect(pidAlive(transport.pid)).toBe(true)
      expect(await supervisor.request("echo", { answer: 42 })).toEqual({ answer: 42 })
      // init payload was delivered by the post-hello handshake.
      expect(await supervisor.request("init", null)).toEqual({ entry: "/ext/fixture", settings: { a: 1 } })
      // Application stdout is logged through the host log callback, never parsed as a frame.
      await events.wait("application stdout is not a protocol frame")
      const stopping = supervisor.stop()
      expect(await outcome(supervisor.request("echo", null))).toMatchObject({ status: "rejected", code: "closed" })
      const stopped = await stopping
      expect(stopped).toMatchObject({
        status: "rootExited",
        exit: { code: 0, signal: null },
        tree: "unproven",
        issues: [],
      })
      expect(pidAlive(transport.pid)).toBe(false)
    },
    30_000,
  )

  run(
    `${runtime}: worker env inherits the host environment and runs in its own process group`,
    async () => {
      const marker = `host-process-env-${Date.now()}`
      process.env[marker] = "inherited"
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "normal", events)
      try {
        await using supervisor = superviseWorker({
          extension: "fixture-ext",
          identity,
          transport,
          limits,
          hooks: { report: events.report },
        })
        await supervisor.ready()
        expect(await supervisor.request("env", marker)).toBe("inherited")
        // A detached POSIX worker is its own process-group leader.
        if (process.platform !== "win32" && typeof process.getpgid === "function") {
          const pgid = process.getpgid(transport.pid!)
          expect(pgid).toBe(transport.pid)
        }
        const spawned = await supervisor.request("spawn", null)
        const grandchild = (spawned as { pid: number }).pid
        expect(pidAlive(grandchild)).toBe(true)
        transport.terminate()
        expect(await transport.exited).toEqual({ code: null, signal: "SIGKILL" })
        // Group kill reaped the grandchild that bypassed host.spawn too.
        expect(pidAlive(grandchild)).toBe(false)
        expect((await supervisor.stop()).status).toBe("rootExited")
      } finally {
        delete process.env[marker]
      }
    },
    30_000,
  )

  run(
    `${runtime}: stopping cancels an entered request and closes admission synchronously`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "normal", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits,
        hooks: { report: events.report },
      })
      await supervisor.ready()
      const request = outcome(supervisor.request("hold", "late value"))
      await events.wait("request-entered method=hold")
      const stopping = supervisor.stop()
      expect(supervisor.stop()).toBe(stopping)
      expect(await request).toEqual({ status: "rejected", code: "closed" })
      expect(await outcome(supervisor.request("echo", null))).toMatchObject({ code: "closed" })
      expect(await stopping).toMatchObject({ status: "rootExited", exit: { code: 0 }, tree: "unproven" })
      expect(events.text()).toContain("drained")
      expect(pidAlive(transport.pid)).toBe(false)
    },
    30_000,
  )

  run(
    `${runtime}: cancellation settles the caller without replaying the request`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "normal", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits,
        hooks: { report: events.report },
      })
      await supervisor.ready()
      const abort = new AbortController()
      const request = outcome(supervisor.request("hold", "discard", abort.signal))
      await events.wait("request-entered method=hold")
      abort.abort()
      expect(await request).toMatchObject({ code: "cancelled" })
      expect(await outcome(supervisor.request("echo", "x".repeat(64 * 1024)))).toMatchObject({ code: "capacity" })
      expect(await supervisor.request("echo", "still ready")).toBe("still ready")
      expect(await outcome(supervisor.request("throw", null))).toMatchObject({ code: "requestFailed" })
    },
    30_000,
  )

  run(
    `${runtime}: host.call and notify round-trip over the real control channel`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      const notified: unknown[] = []
      await using transport = await launch(identity, "normal", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits,
        hooks: {
          report: events.report,
          onHostCall: async (method, value) => ({ granted: method, value }),
          onNotify: (method, value) => notified.push([method, value]),
        },
      })
      await supervisor.ready()
      expect(await supervisor.request("ask", { q: 1 })).toEqual({ granted: "tool.ask", value: { q: 1 } })
      // Frames on one pipe are ordered: the notify event is processed before
      // the request's result frame, so it is already delivered when emit returns.
      expect(await supervisor.request("emit", "hello-event")).toBe("emitted")
      expect(notified).toEqual([["host.emit", "hello-event"]])
      supervisor.notify("session.updated", { id: 1 })
      await events.wait("notify-entered method=session.updated")
      expect((await supervisor.stop()).status).toBe("rootExited")
    },
    30_000,
  )

  for (const behavior of ["disposeThrow", "disposeHang"] as const)
    run(
      `${runtime}: ${behavior} remains visible and cannot prevent external root termination`,
      async () => {
        const identity = testIdentity()
        const events = trace()
        await using transport = await launch(identity, behavior, events)
        await using supervisor = superviseWorker({
          extension: "fixture-ext",
          identity,
          transport,
          limits,
          hooks: { report: events.report },
        })
        await supervisor.ready()
        const result = await supervisor.stop()
        expect(result.status).toBe("rootExited")
        expect(result.tree).toBe("unproven")
        expect(result.issues).toContain(behavior === "disposeThrow" ? "disposeFailed" : "disposeDeadline")
        if (behavior === "disposeHang") expect(events.text()).toContain("force-terminate")
        expect(pidAlive(transport.pid)).toBe(false)
      },
      30_000,
    )

  run(
    `${runtime}: a noncancellable request cannot block the separate dispose command`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "normal", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits,
        hooks: { report: events.report },
      })
      await supervisor.ready()
      const request = outcome(supervisor.request("uncancellable", null))
      await events.wait("request-entered method=uncancellable")
      const result = await supervisor.stop()
      expect(await request).toMatchObject({ code: "closed" })
      expect(result).toMatchObject({ status: "rootExited", exit: { code: 0 }, tree: "unproven" })
      expect(result.issues).toContain("drainDeadline")
      await events.wait("dispose-entered")
      expect(pidAlive(transport.pid)).toBe(false)
    },
    30_000,
  )

  for (const behavior of ["loadThrow", "loadHang"] as const)
    run(
      `${runtime}: ${behavior} never opens request admission`,
      async () => {
        const identity = testIdentity()
        const events = trace()
        await using transport = await launch(identity, behavior, events)
        await using supervisor = superviseWorker({
          extension: "fixture-ext",
          identity,
          transport,
          limits: { ...limits, readinessMs: 100 },
          hooks: { report: events.report },
        })
        await events.wait("loader-entered")
        expect(await outcome(supervisor.ready())).toMatchObject({ status: "rejected", code: "readiness" })
        expect(await outcome(supervisor.request("echo", null))).toMatchObject({ code: "closed" })
        expect((await supervisor.stop()).status).toBe("rootExited")
        expect(pidAlive(transport.pid)).toBe(false)
      },
      30_000,
    )

  run(
    `${runtime}: stop during activation suppresses a late readiness acknowledgement`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "loadUntilAbort", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits,
        hooks: { report: events.report },
      })
      await events.wait("loader-entered")
      expect((await supervisor.stop()).status).toBe("rootExited")
      expect(await outcome(supervisor.ready())).toMatchObject({ code: "closed" })
      expect(events.text()).toContain("loaded-after-close")
      expect(pidAlive(transport.pid)).toBe(false)
    },
    30_000,
  )

  run(
    `${runtime}: dispose acknowledgement does not release the process while the worker is still alive`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "exitHang", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits: { ...limits, exitMs: 10_000 },
        hooks: { report: events.report },
      })
      await supervisor.ready()
      const stopping = supervisor.stop()
      await events.wait("exit-held")
      expect(pidAlive(transport.pid)).toBe(true)
      transport.terminate()
      expect(await stopping).toMatchObject({ status: "rootExited", tree: "unproven" })
      expect(pidAlive(transport.pid)).toBe(false)
    },
    30_000,
  )

  run(
    `${runtime}: control pipe loss terminates the worker without waiting for dispose`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "disposeHang", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits,
        hooks: { report: events.report },
      })
      await supervisor.ready()
      await transport.release()
      // fd EOF is the orphan-cleanup fallback: the worker must exit itself.
      expect(await transport.exited).toEqual({ code: 1, signal: null })
      expect((await supervisor.stop()).status).toBe("rootExited")
    },
    30_000,
  )

  run(
    `${runtime}: unexpected OS root exit rejects an entered request`,
    async () => {
      const identity = testIdentity()
      const events = trace()
      await using transport = await launch(identity, "normal", events)
      await using supervisor = superviseWorker({
        extension: "fixture-ext",
        identity,
        transport,
        limits,
        hooks: { report: events.report },
      })
      await supervisor.ready()
      expect(await outcome(supervisor.request("crash", null))).toMatchObject({ code: "exited" })
      expect(await supervisor.stop()).toMatchObject({
        status: "rootExited",
        exit: { code: 42, signal: null },
        tree: "unproven",
      })
    },
    30_000,
  )
}
