import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { spawnExecutionProcess } from "../../src/extension/execution-process"
import { superviseExecution } from "../../src/extension/execution-supervisor"
import { ExecutionError } from "../../src/extension/execution-protocol"
import { acceptsRuntime, admitRuntime, closeAdmission, recordRuntimeState } from "../../src/extension/lifecycle-state"
import { tryAcquireOwnership } from "../../src/extension/ownership"
import { executionIdentity } from "./execution-fixture"
import { ownershipStorage } from "./ownership-fixture"

const worker = fileURLToPath(new URL("./fixtures/execution-worker.mjs", import.meta.url))
const limits = { readinessMs: 10_000, drainMs: 100, disposeMs: 200, exitMs: 5_000, maxPending: 4 }
function trace() {
  let text = ""
  const listeners = new Set<() => void>()
  return {
    report(event: string) {
      text = (text + event + "\n").slice(-128 * 1024)
      if (process.env.OPENCODE_EXTENSION_LIFECYCLE_TRACE === "1") console.info(event)
      for (const listener of listeners) listener()
    },
    text: () => text,
    async wait(fragment: string) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let listener = () => {}
      try {
        await new Promise<void>((resolve, reject) => {
          listener = () => {
            if (text.includes(fragment)) resolve()
          }
          listeners.add(listener)
          timer = setTimeout(() => reject(new Error(`Missing execution barrier: ${fragment}\n${text}`)), 10_000)
          listener()
        })
      } finally {
        listeners.delete(listener)
        clearTimeout(timer)
      }
    },
  }
}
function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "resolved" as const, value }),
    (error: unknown) => {
      if (error instanceof ExecutionError) return { status: "rejected" as const, code: error.code }
      throw error
    },
  )
}
async function reusable(file: string) {
  const result = await tryAcquireOwnership(file, "exclusive")
  if (result.status !== "acquired") throw new Error("Execution reference remains held after root exit")
  await using lease = result.lease
  await lease.assertHeld()
}

for (const [runtime, executable] of [
  ["bun", Bun.which("bun")],
  ["node", Bun.which("node")],
] as const) {
  const run = test.skipIf(!executable || process.platform !== "darwin")
  const launch = (
    file: string,
    identity: ReturnType<typeof executionIdentity>["identity"],
    behavior: string,
    events: ReturnType<typeof trace>,
  ) =>
    spawnExecutionProcess({
      executable: executable!,
      args: [worker, JSON.stringify(identity), file, behavior],
      frameBytes: 64 * 1024,
      bufferedFrames: 16,
      exitMs: 10_000,
      log: (stream, text) => events.report(`${stream}: ${text}`),
    })

  run(
    `${runtime}: admitted execution holds a reference, isolates stdout and rejects starts after fencing`,
    async () => {
      await using f = await ownershipStorage()
      const { snapshot, identity, operationId } = executionIdentity()
      const gate = await tryAcquireOwnership(path.join(f.root, "mutation.lock"), "exclusive")
      if (gate.status !== "acquired") throw new Error("Missing startup gate")
      await using startupGate = gate.lease
      let state = admitRuntime(snapshot, snapshot, identity)
      const events = trace()
      await using transport = await launch(f.file, identity, "normal", events)
      await using supervisor = superviseExecution({ identity, transport, limits, report: events.report })
      await supervisor.ready().catch((cause) => {
        throw new Error(events.text(), { cause })
      })
      state = recordRuntimeState(state, state, identity, "ready")
      await startupGate.release()
      expect(acceptsRuntime(state, identity)).toBe(true)
      expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
      expect(await supervisor.request("echo", { answer: 42 })).toEqual({ answer: 42 })
      await events.wait("application stdout is not a protocol frame")
      const stopGate = await tryAcquireOwnership(path.join(f.root, "mutation.lock"), "exclusive")
      if (stopGate.status !== "acquired") throw new Error("Missing stop gate")
      await using closingGate = stopGate.lease
      state = closeAdmission(state, state, operationId)
      const stopping = supervisor.stop()
      expect(acceptsRuntime(state, identity)).toBe(false)
      expect(await outcome(supervisor.request("echo", null))).toMatchObject({ status: "rejected", code: "closed" })
      const stopped = await stopping
      expect(stopped).toMatchObject({
        status: "rootExited",
        exit: { code: 0, signal: null },
        tree: "unproven",
        issues: [],
      })
      state = recordRuntimeState(state, state, identity, "rootExited")
      expect(state.admission.status).toBe("closing")
      await reusable(f.file)
    },
    30_000,
  )

  run(
    `${runtime}: stopping cancels an entered request and closes admission synchronously`,
    async () => {
      await using f = await ownershipStorage()
      const { identity } = executionIdentity()
      const events = trace()
      await using transport = await launch(f.file, identity, "normal", events)
      await using supervisor = superviseExecution({ identity, transport, limits, report: events.report })
      await supervisor.ready()
      const request = outcome(supervisor.request("hold", "late value"))
      await events.wait("request-entered method=hold")
      const stopping = supervisor.stop()
      expect(supervisor.stop()).toBe(stopping)
      expect(await request).toEqual({ status: "rejected", code: "closed" })
      expect(await outcome(supervisor.request("echo", null))).toMatchObject({ code: "closed" })
      expect(await stopping).toMatchObject({ status: "rootExited", exit: { code: 0 }, tree: "unproven" })
      expect(events.text()).toContain("drained")
      await reusable(f.file)
    },
    30_000,
  )

  run(
    `${runtime}: cancellation settles the caller without replaying the request`,
    async () => {
      await using f = await ownershipStorage()
      const { identity } = executionIdentity()
      const events = trace()
      await using transport = await launch(f.file, identity, "normal", events)
      await using supervisor = superviseExecution({ identity, transport, limits, report: events.report })
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

  for (const behavior of ["disposeThrow", "disposeHang"] as const)
    run(
      `${runtime}: ${behavior} remains visible and cannot prevent external root termination`,
      async () => {
        await using f = await ownershipStorage()
        const { identity } = executionIdentity()
        const events = trace()
        await using transport = await launch(f.file, identity, behavior, events)
        await using supervisor = superviseExecution({ identity, transport, limits, report: events.report })
        await supervisor.ready()
        const result = await supervisor.stop()
        expect(result.status).toBe("rootExited")
        expect(result.tree).toBe("unproven")
        expect(result.issues).toContain(behavior === "disposeThrow" ? "disposeFailed" : "disposeDeadline")
        if (behavior === "disposeHang") expect(events.text()).toContain("force-terminate")
        await reusable(f.file)
      },
      30_000,
    )

  run(
    `${runtime}: a noncancellable request cannot block the separate dispose command`,
    async () => {
      await using f = await ownershipStorage()
      const { identity } = executionIdentity()
      const events = trace()
      await using transport = await launch(f.file, identity, "normal", events)
      await using supervisor = superviseExecution({ identity, transport, limits, report: events.report })
      await supervisor.ready()
      const request = outcome(supervisor.request("uncancellable", null))
      await events.wait("request-entered method=uncancellable")
      const result = await supervisor.stop()
      expect(await request).toMatchObject({ code: "closed" })
      expect(result).toMatchObject({ status: "rootExited", exit: { code: 0 }, tree: "unproven" })
      expect(result.issues).toContain("drainDeadline")
      await events.wait("dispose-entered")
      await reusable(f.file)
    },
    30_000,
  )

  for (const behavior of ["loadThrow", "loadHang"] as const)
    run(
      `${runtime}: ${behavior} never opens request admission`,
      async () => {
        await using f = await ownershipStorage()
        const { identity } = executionIdentity()
        const events = trace()
        await using transport = await launch(f.file, identity, behavior, events)
        await using supervisor = superviseExecution({
          identity,
          transport,
          limits: { ...limits, readinessMs: 100 },
          report: events.report,
        })
        await events.wait("loader-entered")
        expect(await outcome(supervisor.ready())).toMatchObject({ status: "rejected", code: "readiness" })
        expect(await outcome(supervisor.request("echo", null))).toMatchObject({ code: "closed" })
        expect((await supervisor.stop()).status).toBe("rootExited")
        await reusable(f.file)
      },
      30_000,
    )

  run(
    `${runtime}: stop during activation suppresses a late readiness acknowledgement`,
    async () => {
      await using f = await ownershipStorage()
      const { identity } = executionIdentity()
      const events = trace()
      await using transport = await launch(f.file, identity, "loadUntilAbort", events)
      await using supervisor = superviseExecution({ identity, transport, limits, report: events.report })
      await events.wait("loader-entered")
      expect((await supervisor.stop()).status).toBe("rootExited")
      expect(await outcome(supervisor.ready())).toMatchObject({ code: "closed" })
      expect(events.text()).toContain("loaded-after-close")
      await reusable(f.file)
    },
    30_000,
  )

  run(
    `${runtime}: dispose acknowledgement does not release the reference while execution is still alive`,
    async () => {
      await using f = await ownershipStorage()
      const { identity } = executionIdentity()
      const events = trace()
      await using transport = await launch(f.file, identity, "exitHang", events)
      await using supervisor = superviseExecution({
        identity,
        transport,
        limits: { ...limits, exitMs: 10_000 },
        report: events.report,
      })
      await supervisor.ready()
      const stopping = supervisor.stop()
      await events.wait("exit-held")
      expect(await tryAcquireOwnership(f.file, "exclusive")).toEqual({ status: "busy" })
      transport.terminate()
      expect(await stopping).toMatchObject({ status: "rootExited", tree: "unproven" })
      await reusable(f.file)
    },
    30_000,
  )

  run(
    `${runtime}: control pipe loss terminates the worker without waiting for dispose`,
    async () => {
      await using f = await ownershipStorage()
      const { identity } = executionIdentity()
      const events = trace()
      await using transport = await launch(f.file, identity, "disposeHang", events)
      await using supervisor = superviseExecution({ identity, transport, limits, report: events.report })
      await supervisor.ready()
      await transport.release()
      expect(await transport.exited).toEqual({ code: 1, signal: null })
      expect((await supervisor.stop()).status).toBe("rootExited")
      await reusable(f.file)
    },
    30_000,
  )

  run(
    `${runtime}: unexpected OS root exit rejects an entered request`,
    async () => {
      await using f = await ownershipStorage()
      const { identity } = executionIdentity()
      const events = trace()
      await using transport = await launch(f.file, identity, "normal", events)
      await using supervisor = superviseExecution({ identity, transport, limits, report: events.report })
      await supervisor.ready()
      expect(await outcome(supervisor.request("crash", null))).toMatchObject({ code: "exited" })
      expect(await supervisor.stop()).toMatchObject({
        status: "rootExited",
        exit: { code: 42, signal: null },
        tree: "unproven",
      })
      await reusable(f.file)
    },
    30_000,
  )
}
