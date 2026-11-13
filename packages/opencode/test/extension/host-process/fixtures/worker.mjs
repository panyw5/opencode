import { spawn } from "node:child_process"
import { Schema } from "effect"
import { RuntimeIdentity } from "../../../../src/extension/host-process/protocol.ts"
import { openWorkerChannel, serveWorker } from "../../../../src/extension/host-process/worker.ts"

const [rawIdentity, behavior] = process.argv.slice(2)
const identity = Schema.decodeUnknownSync(RuntimeIdentity)(JSON.parse(rawIdentity))
const report = (event) => process.stderr.write(`${event}\n`)

let initPayload = null
let hostChannel = null

async function main() {
  const channel = openWorkerChannel({ frameBytes: 64 * 1024 })
  const outcome = await serveWorker({
    identity,
    channel,
    maxRequests: 4,
    report,
    disconnect: () => process.exit(1),
    async load(init, host, signal) {
      initPayload = init
      hostChannel = host
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
          if (method === "init") return initPayload
          if (method === "env") return process.env[String(value)]
          if (method === "ask") return host.call("tool.ask", value)
          if (method === "emit") {
            await host.notify("host.emit", value)
            return "emitted"
          }
          if (method === "spawn") {
            // Same process group as the worker root (detached is off), so a
            // forced group kill must reap this grandchild too.
            const child = spawn("sleep", ["60"], { detached: false, stdio: "ignore" })
            return { pid: child.pid }
          }
          return value
        },
        async notify(method, value) {
          report(`fixture notify-entered method=${method} value=${JSON.stringify(value)}`)
        },
        async dispose() {
          report("fixture dispose-entered")
          if (behavior === "disposeThrow") throw new Error("Fixture dispose failed")
          if (behavior === "disposeHang") await new Promise(() => {})
        },
      }
    },
  })
  if (behavior === "exitHang") {
    report("fixture exit-held")
    await new Promise(() => {})
  }
  // Keep the control descriptors alive until OS exit, including after dispose acknowledgement.
  process.exit(outcome === "disposed" ? 0 : 1)
}

try {
  await main()
} catch (error) {
  report(`fixture failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
