import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

// Test-only trusted execution unit. Never loads an installed extension or user configuration.
const depth = Number(process.argv[2])
const behavior = process.argv[3]
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, pid: process.pid })}\n`)
const pending = new Set()
let ticks = 0
const timer = setInterval(() => ticks++, 10)
let child
let childClosed
let descendants = []

if (depth > 0) {
  child = spawn(process.execPath, [import.meta.filename, String(depth - 1), behavior], {
    stdio: ["pipe", "pipe", "inherit"],
  })
  childClosed = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  // Attach immediately so a failed descendant startup is not an unhandled rejection.
  childClosed.catch((error) => {
    emit({ type: "childError", message: error.message })
    process.exitCode = 1
  })
  descendants = await new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    child.once("error", reject)
    child.once("exit", () => reject(new Error("Descendant exited before ready")))
    lines.on("line", (line) => {
      const event = JSON.parse(line)
      if (event.type === "ready") resolve([event.pid, ...event.descendants])
    })
  })
}

if (behavior === "ignore-term") {
  process.on("SIGTERM", () => emit({ type: "signalIgnored" }))
}

async function exit() {
  if (child) {
    child.stdin.end(`${JSON.stringify({ type: "exit" })}\n`)
    const outcome = await childClosed
    if (outcome.code !== 0 || outcome.signal) throw new Error("Descendant did not exit cleanly")
  }
  clearInterval(timer)
  // Flush the handshake/disposal events before ending the fixture.
  process.stdout.end(() => process.exit(0))
}

const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const command = JSON.parse(line)
  switch (command.type) {
    case "request":
      pending.add(command.requestId)
      emit({ type: "requestStarted", requestId: command.requestId })
      break
    case "cancel":
      if (!pending.delete(command.requestId)) throw new Error("Unknown request")
      emit({ type: "requestCancelled", requestId: command.requestId })
      break
    case "inspect":
      emit({ type: "inspection", pending: pending.size, ticks })
      break
    case "dispose":
      emit({ type: "disposing" })
      if (behavior === "throw") {
        emit({ type: "disposeFailed", code: "fixtureDisposeFailed" })
        break
      }
      if (behavior === "hang" || behavior === "ignore-term") break
      void exit().catch((error) => {
        emit({ type: "exitFailed", message: error.message })
        process.exit(1)
      })
      break
    case "exit":
      void exit().catch((error) => {
        emit({ type: "exitFailed", message: error.message })
        process.exit(1)
      })
      break
    default:
      throw new Error("Unknown lifecycle fixture command")
  }
})

emit({ type: "ready", descendants, runtime: process.versions.bun ? "bun" : "node" })
