import { createRequire } from "node:module"
import { createReadStream, createWriteStream } from "node:fs"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const net = require("node:net")
const trace = (stage, error) =>
  console.error(
    `fd-probe pid=${process.pid} runtime=${process.versions.bun ? "bun" : "node"} stage=${stage} code=${error?.code ?? "none"} path=${error?.path ?? "none"} cause=${error?.cause?.code ?? "none"} stack=${error?.stack?.replaceAll("\n", " | ") ?? "none"}`,
  )
for (const key of ["connect", "createConnection"]) {
  const original = net[key]
  net[key] = function (...args) {
    const value = args[0]
    trace(
      `net.${key} argument=${typeof value === "string" || typeof value === "number" ? value : `fd:${value?.fd ?? "none"},path:${value?.path ?? "none"}`}`,
    )
    const result = original.apply(this, args)
    trace(`net.${key} returned connecting=${result.connecting}`)
    result.once("connect", () => trace(`net.${key} connected`))
    result.once("error", (error) => trace(`net.${key} error`, error))
    return result
  }
}

if (process.argv[2] === "worker") {
  trace("worker-open-fs")
  const input = createReadStream("", { fd: 3 })
  const output = createWriteStream("", { fd: 4 })
  input.on("error", (error) => {
    trace("worker-input-error", error)
    process.exitCode = 1
  })
  output.on("error", (error) => {
    trace("worker-output-error", error)
    process.exitCode = 1
  })
  input.once("data", () => {
    trace("worker-input-data")
    output.end("probe-reply\n", () => trace("worker-output-flushed"))
    input.destroy()
  })
  input.once("end", () => trace("worker-input-end"))
} else {
  const { spawn } = await import("node:child_process")
  const childRuntime = process.argv[2]
  const rounds = Number(process.argv[3] ?? 1)
  let failures = 0
  for (let round = 0; round < rounds; round++) {
    await new Promise((resolve) => {
      let child
      try {
        child = spawn(childRuntime, [fileURLToPath(import.meta.url), "worker"], {
          stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        })
      } catch (error) {
        trace(`host-spawn-threw round=${round}`, error)
        failures++
        return resolve()
      }
      trace(`host-spawned child=${child.pid} round=${round}`)
      let received = false
      const timer = setTimeout(() => {
        trace(`host-timeout child=${child.pid}`)
        child.kill("SIGKILL")
      }, 2000)
      for (const [fd, pipe] of child.stdio.entries())
        pipe?.on("error", (error) => trace(`host-pipe-error child=${child.pid} fd=${fd}`, error))
      child.stderr.on("data", (bytes) => process.stderr.write(bytes))
      child.stdio[4].once("data", () => {
        received = true
        trace(`host-reply child=${child.pid}`)
      })
      child.on("error", (error) => trace(`host-child-error child=${child.pid}`, error))
      child.once("exit", (code, signal) => {
        clearTimeout(timer)
        trace(`host-exit child=${child.pid} exit=${code} signal=${signal} received=${received}`)
        if (code !== 0 || !received) failures++
        for (const pipe of child.stdio) pipe?.destroy()
        resolve()
      })
      child.stdio[3].write("probe-command\n")
    })
  }
  trace(`summary rounds=${rounds} failures=${failures}`)
  process.exitCode = failures ? 1 : 0
}
