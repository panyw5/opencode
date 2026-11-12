import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { lifecycleProcess } from "./lifecycle-process"

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

test("lifecycle fixture reports spawn failure and still closes its process handle", async () => {
  await using worker = lifecycleProcess(fileURLToPath(new URL("./fixtures/missing-executable", import.meta.url)))
  await expect(worker.wait("ready")).rejects.toMatchObject({ code: "ENOENT" })
  expect((await worker.closed()).signal).toBeNull()
}, 30_000)

for (const [runtime, executable] of [
  ["bun", process.execPath],
  ["node", Bun.which("node")],
] as const) {
  describe(`lifecycle process prototype (${runtime})`, () => {
    test.skipIf(!executable)(
      "starts a real execution process and acknowledges cancellation",
      async () => {
        await using worker = lifecycleProcess(executable!)
        const ready = await worker.wait("ready")
        expect(ready.runtime).toBe(runtime)
        expect(ready.pid).not.toBe(process.pid)
        worker.send({ type: "request", requestId: "pending-rpc" })
        expect((await worker.wait("requestStarted")).requestId).toBe("pending-rpc")
        worker.send({ type: "inspect" })
        expect((await worker.wait("inspection")).pending).toBe(1)
        worker.send({ type: "cancel", requestId: "pending-rpc" })
        expect((await worker.wait("requestCancelled")).requestId).toBe("pending-rpc")
        worker.send({ type: "inspect" })
        expect((await worker.wait("inspection")).pending).toBe(0)
        worker.send({ type: "dispose" })
        await worker.wait("disposing")
        expect(await worker.closed()).toEqual({ code: 0, signal: null })
        expect(alive(ready.pid)).toBe(false)
      },
      30_000,
    )

    test.skipIf(!executable)(
      "a dispose exception is observable and does not prove exit",
      async () => {
        await using worker = lifecycleProcess(executable!, { behavior: "throw" })
        const ready = await worker.wait("ready")
        worker.send({ type: "dispose" })
        await worker.wait("disposing")
        await worker.wait("disposeFailed")
        expect(alive(ready.pid)).toBe(true)
        worker.send({ type: "inspect" })
        await worker.wait("inspection")
        worker.send({ type: "exit" })
        expect(await worker.closed()).toEqual({ code: 0, signal: null })
      },
      30_000,
    )

    test.skipIf(!executable)(
      "a hanging dispose still allows the external owner to terminate the process",
      async () => {
        await using worker = lifecycleProcess(executable!, { behavior: "hang" })
        await worker.wait("ready")
        worker.send({ type: "dispose" })
        await worker.wait("disposing")
        worker.send({ type: "inspect" })
        await worker.wait("inspection")
        worker.signal("SIGKILL")
        expect((await worker.closed()).signal).toBe("SIGKILL")
      },
      30_000,
    )

    // A Windows tree requires a Job Object; a POSIX process-group result cannot cover it.
    test.skipIf(!executable || process.platform === "win32")(
      "cooperative stop reaps children and grandchildren",
      async () => {
        await using worker = lifecycleProcess(executable!, { depth: 2 })
        const ready = await worker.wait("ready")
        expect(ready.descendants).toHaveLength(2)
        expect(ready.descendants!.every(alive)).toBe(true)
        worker.send({ type: "dispose" })
        await worker.wait("disposing")
        expect(await worker.closed()).toEqual({ code: 0, signal: null })
        expect([ready.pid, ...ready.descendants!].some(alive)).toBe(false)
      },
      30_000,
    )

    test.skipIf(!executable || process.platform === "win32")(
      "escalates outside a process tree that ignores SIGTERM",
      async () => {
        await using worker = lifecycleProcess(executable!, { depth: 2, behavior: "ignore-term" })
        const ready = await worker.wait("ready")
        expect(ready.descendants).toHaveLength(2)
        worker.signal("SIGTERM", true)
        await worker.wait("signalIgnored")
        worker.send({ type: "inspect" })
        await worker.wait("inspection")
        worker.signal("SIGKILL", true)
        expect((await worker.exited()).signal).toBe("SIGKILL")
        expect((await worker.closed()).signal).toBe("SIGKILL")
        // Inherited-pipe closure is evidence for this fixture, not a generic tree-exit proof.
      },
      30_000,
    )

    test.skipIf(!executable || process.platform === "win32")(
      "root exit alone leaves descendants running",
      async () => {
        await using worker = lifecycleProcess(executable!, { depth: 2 })
        const ready = await worker.wait("ready")
        worker.signal("SIGKILL")
        expect((await worker.exited()).signal).toBe("SIGKILL")
        expect(ready.descendants).toHaveLength(2)
        expect(ready.descendants!.every(alive)).toBe(true)
        worker.signal("SIGKILL", true)
        await worker.closed()
      },
      30_000,
    )
  })
}
