import { createInterface } from "node:readline"
import { tryAcquireOwnership } from "../../../src/extension/ownership.ts"

const [file, mode] = process.argv.slice(2)
const runtime = process.versions.electron ? "electron" : process.versions.bun ? "bun" : "node"
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, pid: process.pid, runtime })}\n`)
let lease

async function acquire() {
  if (lease) throw new Error("Fixture already owns a lease")
  const result = await tryAcquireOwnership(file, mode)
  if (result.status === "acquired") lease = result.lease
  emit({ type: result.status })
}

async function release() {
  await lease?.release()
  lease = undefined
  emit({ type: "released" })
}

async function exit() {
  await release()
  process.stdout.end(() => process.exit(0))
}

let work = Promise.resolve()
function command(input) {
  work = work
    .then(async () => {
      switch (input.type) {
        case "acquire":
          await acquire()
          break
        case "touch": {
          const { open } = await import("node:fs/promises")
          const other = await open(file, "r")
          await other.close()
          emit({ type: "touched" })
          break
        }
        case "assert":
          if (!lease) throw new Error("Fixture has no lease")
          await lease.assertHeld()
          emit({ type: "held" })
          break
        case "release":
          await release()
          break
        case "exit":
          await exit()
          break
        default:
          throw new Error("Unknown ownership fixture command")
      }
    })
    .catch((error) => emit({ type: "error", code: error.code, message: error.message }))
}

if (process.parentPort) {
  process.parentPort.on("message", (event) => command(event.data))
} else {
  const lines = createInterface({ input: process.stdin })
  lines.on("line", (line) => command(JSON.parse(line)))
  lines.on("close", () => command({ type: "exit" }))
}

await acquire().catch((error) => {
  emit({ type: "error", code: error.code, message: error.message })
  process.exitCode = 1
})
