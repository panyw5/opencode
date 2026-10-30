import { parentPort } from "node:worker_threads"
import { load, normalize, type Limits, type Result } from "./photon-normalize"

export type Request = { base64: string; limits: Limits }
export type Reply = { type: "ready" } | { type: "done"; result: Result }

if (parentPort) {
  const port = parentPort
  const photon = await load()
  port.on("message", (request: Request) => {
    port.postMessage({ type: "done", result: normalize(photon, request.base64, request.limits) } satisfies Reply)
  })
  port.postMessage({ type: "ready" } satisfies Reply)
}
