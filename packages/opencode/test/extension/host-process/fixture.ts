import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { HostProcessError, makeIdentity, type RuntimeIdentity } from "../../../src/extension/host-process/protocol.ts"
import type { SupervisorLimits } from "../../../src/extension/host-process/supervisor.ts"

/** Isolated fence coordinates with no relationship to an installed extension or user registry. */
export function testFence() {
  return { store: randomUUID(), installation: randomUUID(), generation: 0, epoch: 0 }
}

export function testIdentity(fence = testFence()): RuntimeIdentity {
  return makeIdentity(fence)
}

export const workerFixture = fileURLToPath(new URL("./fixtures/worker.mjs", import.meta.url))
export const fdOwnerFixture = fileURLToPath(new URL("./fixtures/fd-owner.mjs", import.meta.url))

export function testLimits(over: Partial<SupervisorLimits> = {}): SupervisorLimits {
  return {
    frameBytes: 64 * 1024,
    bufferedFrames: 16,
    readinessMs: 10_000,
    drainMs: 100,
    disposeMs: 200,
    exitMs: 5_000,
    maxPending: 4,
    restartBackoffMs: [50, 50, 50],
    ...over,
  }
}

/** Nonthrowing diagnostic sink with an async barrier for ordering assertions. */
export function trace() {
  let text = ""
  const listeners = new Set<() => void>()
  return {
    report(event: string) {
      text = (text + event + "\n").slice(-128 * 1024)
      if (process.env.OPENCODE_HOST_PROCESS_TRACE === "1") console.info(event)
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
          timer = setTimeout(() => reject(new Error(`Missing host-process barrier: ${fragment}\n${text}`)), 10_000)
          timer.unref?.()
          listener()
        })
      } finally {
        listeners.delete(listener)
        clearTimeout(timer)
      }
    },
  }
}

/** Normalize worker failures into assertion-friendly outcomes. */
export function outcome<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: "resolved" as const, value }),
    (error: unknown) => {
      if (error instanceof HostProcessError) return { status: "rejected" as const, code: error.code }
      throw error
    },
  )
}

/** Liveness of an OS pid; used where the prototype asserted ownership-lease residency. */
export function pidAlive(pid: number | undefined) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
