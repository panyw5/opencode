import { parentPort } from "node:worker_threads"

parentPort!.on("message", () => {
  throw new Error("simulated image worker crash")
})
parentPort!.postMessage({ type: "ready" })
