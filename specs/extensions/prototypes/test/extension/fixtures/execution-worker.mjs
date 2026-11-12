import { Schema } from "effect"
import { RuntimeIdentity } from "../../../src/extension/lifecycle-state.ts"
import { tryAcquireOwnership } from "../../../src/extension/ownership.ts"
import { decodeExecutionEvent } from "../../../src/extension/execution-protocol.ts"
import { openWorkerChannel, serveExecution } from "../../../src/extension/execution-worker.ts"

const [rawIdentity, guard, behavior] = process.argv.slice(2)
const identity = Schema.decodeUnknownSync(RuntimeIdentity)(JSON.parse(rawIdentity))
const report = (event) => process.stderr.write(`${event}\n`)

async function main() {
  const result = await tryAcquireOwnership(guard, "shared")
  if (result.status !== "acquired") throw new Error("Execution fixture reference is busy")
  await using lease = result.lease
  try {
    // Electron utility processes use parentPort; Node/Bun use the reserved fd pair.
    const port = process.parentPort
    await using channel = port
      ? {
          async send(event) {
            port.postMessage(decodeExecutionEvent(event))
          },
          listen(message) {
            const listener = (event) => message(event.data)
            port.on("message", listener)
            return () => port.off("message", listener)
          },
          async [Symbol.asyncDispose]() {
            /* Electron owns parentPort; serveExecution removes its listener. */
          },
        }
      : openWorkerChannel(64 * 1024)
    const outcome = await serveExecution({
      identity,
      channel,
      maxRequests: 4,
      report,
      disconnect: () => process.exit(1),
      async load(signal) {
        report("fixture loader-entered")
        if (behavior === "loadThrow") throw new Error("Fixture activation failed")
        if (behavior === "loadHang") await new Promise(() => {})
        if (behavior === "loadUntilAbort")
          await new Promise((resolve) => {
            if (signal.aborted) return resolve()
            signal.addEventListener("abort", resolve, { once: true })
          })
        process.stdout.write("application stdout is not a protocol frame\n")
        return {
          async request(method, value, signal) {
            report(`fixture request-entered method=${method}`)
            if (method === "crash") process.exit(42)
            if (method === "throw") throw new Error("Fixture request failed")
            if (method === "uncancellable") return new Promise(() => {})
            if (method === "hold")
              await new Promise((resolve) => {
                if (signal.aborted) return resolve()
                signal.addEventListener("abort", resolve, { once: true })
              })
            return value
          },
          async dispose() {
            report("fixture dispose-entered")
            if (behavior === "disposeThrow") throw new Error("Fixture dispose failed")
            if (behavior === "disposeHang") await new Promise(() => {})
          },
        }
      },
    })
    await lease.assertHeld()
    if (behavior === "exitHang") {
      report("fixture exit-held")
      await new Promise(() => {})
    }
    // Keep the reference and control descriptors alive until OS exit, including after dispose acknowledgement.
    process.exit(outcome === "disposed" ? 0 : 1)
  } catch (error) {
    try {
      report(`fixture failed while holding reference: ${error.message}`)
    } finally {
      process.exit(1)
    }
  }
}

try {
  await main()
} catch (error) {
  report(`fixture failed: ${error.message}`)
  process.exit(1)
}
