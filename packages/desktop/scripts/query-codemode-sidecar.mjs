import { Effect, Layer } from "effect"

const { Database, Log, Server } = await import("../../opencode/dist/node/node.js")
await Log.init({ level: "INFO" })
await Effect.runPromise(Effect.scoped(Layer.build(Database.defaultLayer)))
const server = await Server.listen({
  hostname: "127.0.0.1",
  port: 0,
  username: "opencode",
  password: process.env.OPENCODE_SERVER_PASSWORD,
})
process.send({ url: server.url.toString(), username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD })
process.on("message", async (message) => {
  if (message !== "stop") return
  await server.stop(true)
  process.exit(0)
})
