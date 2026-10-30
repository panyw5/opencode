import { parentPort } from "node:worker_threads"

parentPort!.on("message", () => parentPort!.postMessage({ type: "started" }))
parentPort!.postMessage({ type: "ready" })
