import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { serveExecution, type ExecutionApplication, type WorkerChannel } from "../../src/extension/execution-worker"
import { RequestID, type ExecutionEvent } from "../../src/extension/execution-protocol"
import { executionIdentity } from "./execution-fixture"

test("worker rejects pre-ready and over-capacity commands while cancellation and disposal remain available", async () => {
  const { identity } = executionIdentity()
  const events: ExecutionEvent[] = []
  const listeners = new Set<() => void>()
  let receive: (input: unknown) => void = () => {}
  let loaded!: (application: ExecutionApplication) => void
  let entered!: () => void
  let removed = 0
  let requests = 0
  const loading = new Promise<ExecutionApplication>((resolve) => {
    loaded = resolve
  })
  const requesting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const channel: WorkerChannel = {
    async send(event) {
      events.push(event)
      for (const listener of listeners) listener()
    },
    listen(message) {
      receive = message
      return () => {
        removed++
        receive = () => {}
      }
    },
  }
  async function event(type: ExecutionEvent["type"]) {
    let listener = () => {}
    try {
      return await new Promise<ExecutionEvent>((resolve) => {
        listener = () => {
          const index = events.findIndex((entry) => entry.type === type)
          if (index !== -1) resolve(events.splice(index, 1)[0]!)
        }
        listeners.add(listener)
        listener()
      })
    } finally {
      listeners.delete(listener)
    }
  }
  const envelope = { version: 1, identity }
  const requestId = () => Schema.decodeUnknownSync(RequestID)(randomUUID())
  const serving = serveExecution({
    identity,
    channel,
    maxRequests: 1,
    report() {},
    load: () => loading,
    disconnect: () => {
      throw new Error("Unexpected fake channel disconnect")
    },
  })
  await event("hello")
  receive({ ...envelope, type: "request", requestId: requestId(), method: "early", value: null })
  expect(await event("rejected")).toMatchObject({ code: "closed" })
  loaded({
    async request(_method, value, signal) {
      requests++
      entered()
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      return value
    },
    async dispose() {},
  })
  await event("ready")
  expect(requests).toBe(0)
  const first = requestId()
  receive({ ...envelope, type: "request", requestId: first, method: "hold", value: "late" })
  await requesting
  receive({ ...envelope, type: "request", requestId: requestId(), method: "full", value: null })
  expect(await event("rejected")).toMatchObject({ code: "capacity" })
  receive({ ...envelope, type: "cancel", requestId: first })
  expect(await event("rejected")).toMatchObject({ code: "cancelled", requestId: first })
  receive({ ...envelope, type: "drain" })
  await event("drained")
  receive({ ...envelope, type: "dispose" })
  await event("disposed")
  expect(await serving).toBe("disposed")
  expect(removed).toBe(1)
  expect(requests).toBe(1)
})
