import { app, utilityProcess } from "electron"
import { createInterface } from "node:readline"
import { Schema } from "effect"
import { RuntimeIdentity } from "../../../src/extension/lifecycle-state.ts"
import { decodeExecutionCommand } from "../../../src/extension/execution-protocol.ts"
import { superviseExecution } from "../../../src/extension/execution-supervisor.ts"

function argument(name) {
  const prefix = `--probe-${name}=`
  const value = process.argv.find((value) => value.startsWith(prefix))
  if (!value) throw new Error(`Missing supervisor probe argument: ${name}`)
  return value.slice(prefix.length)
}
const identity = Schema.decodeUnknownSync(RuntimeIdentity)(JSON.parse(argument("identity")))
const child = utilityProcess.fork(
  argument("worker"),
  [JSON.stringify(identity), argument("guard"), argument("behavior")],
  { stdio: "pipe", serviceName: "extension lifecycle supervisor probe" },
)
let outcome
let parentGone = false
let receive = () => {}
let receiveFailure = () => {}
const onMessage = (input) => receive(input)
const onError = (error) => receiveFailure(new Error(`Utility transport failed: ${String(error)}`))
child.on("message", onMessage)
child.on("error", onError)
const stdout = child.stdout
const stderr = child.stderr
stdout.on("data", (bytes) => {
  if (!parentGone) process.stderr.write(`utility stdout: ${bytes.toString()}`)
})
stderr.on("data", (bytes) => {
  if (!parentGone) process.stderr.write(bytes)
})
const exited = new Promise((resolve) =>
  child.once("exit", (code) => {
    outcome = { code, signal: null }
    resolve(outcome)
  }),
)
const transport = {
  exited,
  subscribe(message, failure) {
    receive = message
    receiveFailure = failure
    return () => {
      receive = () => {}
      receiveFailure = () => {}
    }
  },
  send(command) {
    child.postMessage(decodeExecutionCommand(command))
  },
  terminate() {
    if (!outcome && !child.kill()) throw new Error("Utility termination could not be requested")
  },
  async release() {
    child.off("message", onMessage)
    child.off("error", onError)
    await Promise.all(
      [stdout, stderr].map(
        (pipe) =>
          new Promise((resolve) => {
            if (pipe.closed) return resolve()
            pipe.once("close", resolve)
            pipe.destroy()
          }),
      ),
    )
  },
}
const report = (event) => {
  if (!parentGone) process.stderr.write(`${event}\n`)
}
const emit = (event) => {
  if (!parentGone) process.stdout.write(`${JSON.stringify({ ...event, pid: process.pid, runtime: "electron" })}\n`)
}

async function main() {
  await using supervisor = superviseExecution({
    identity,
    transport,
    limits: { readinessMs: 10_000, drainMs: 200, disposeMs: 200, exitMs: 5000, maxPending: 4 },
    report,
  })
  let disconnecting
  const disconnect = () => {
    parentGone = true
    disconnecting ??= supervisor.stop().then(
      () => app.exit(1),
      () => app.exit(1),
    )
  }
  process.stdout.on("error", disconnect)
  process.stderr.on("error", disconnect)
  process.on("SIGTERM", disconnect)
  try {
    await supervisor.ready()
  } catch (error) {
    emit({ type: "readiness-rejected", code: error.code })
    await supervisor.stop()
    return
  }
  emit({ type: "supervisor-ready" })
  await new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin })
    lines.on("line", (line) => {
      const task = (async () => {
        const command = JSON.parse(line)
        if (command.type === "request") {
          const value = await supervisor.request("echo", "electron echo")
          emit({ type: "reply", message: value })
          return
        }
        if (command.type !== "dispose") throw new Error("Unexpected supervisor probe command")
        const result = await supervisor.stop()
        if (result.status !== "rootExited") throw new Error("Utility exit remains unproven")
        emit({
          type: "supervisor-stopped",
          exitCode: result.exit.code,
          code: result.issues.join(","),
          message: result.tree,
        })
        resolve()
        lines.close()
      })()
      void task.catch(reject)
    })
    lines.once("close", () => {
      if (!outcome) disconnect()
    })
  })
}
await main()
process.stdout.end(() => app.exit(0))
