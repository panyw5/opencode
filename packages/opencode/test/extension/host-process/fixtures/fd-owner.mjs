import { openWorkerChannel } from "../../../../src/extension/host-process/worker.ts"

const identity = JSON.parse(process.argv[2])
const channel = openWorkerChannel({ frameBytes: 4096 })
const hold = setInterval(() => {}, 1000)
channel.listen(
  async (command) => {
    if (command.type !== "drain") return
    await channel.send({ version: 1, identity, type: "drained" })
    clearInterval(hold)
    process.exit(0)
  },
  () => process.exit(2),
  () => process.exit(3),
)
await channel.send({ version: 1, identity, type: "hello" })
