import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { serveWorker, type WorkerApplication, type WorkerChannel } from "../../../src/extension/host-process/worker.ts"
import { RequestID, type WorkerEvent } from "../../../src/extension/host-process/protocol.ts"
import { testIdentity } from "./fixture.ts"

function fakeChannel() {
  const events: WorkerEvent[] = []
  const listeners = new Set<() => void>()
  let receive: (input: unknown) => void = () => {}
  let failed: (error: Error) => void = () => {}
  let disconnected: () => void = () => {}
  let removed = 0
  let closed = false
  const channel: WorkerChannel = {
    async send(event) {
      events.push(event)
      for (const listener of listeners) listener()
    },
    listen(message, failure, disconnect) {
      receive = message
      failed = failure
      disconnected = disconnect
      return () => {
        removed++
        receive = () => {}
      }
    },
    async close() {
      closed = true
    },
  }
  async function event(type: WorkerEvent["type"]) {
    let listener = () => {}
    try {
      return await new Promise<WorkerEvent>((resolve) => {
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
  return {
    channel,
    event,
    emit: (command: unknown) => receive(command),
    fail: (error: Error) => failed(error),
    disconnect: () => disconnected(),
    removed: () => removed,
    closed: () => closed,
    events,
  }
}

const requestId = () => Schema.decodeUnknownSync(RequestID)(randomUUID())

test("worker rejects pre-ready and over-capacity commands while cancellation and disposal remain available", async () => {
  const identity = testIdentity()
  const c = fakeChannel()
  let loaded!: (application: WorkerApplication) => void
  let entered!: () => void
  let requests = 0
  const loading = new Promise<WorkerApplication>((resolve) => {
    loaded = resolve
  })
  const requesting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const envelope = { version: 1 as const, identity }
  const serving = serveWorker({
    identity,
    channel: c.channel,
    maxRequests: 1,
    report() {},
    load: () => loading,
    disconnect: () => {
      throw new Error("Unexpected fake channel disconnect")
    },
  })
  await c.event("hello")
  c.emit({ ...envelope, type: "request", requestId: requestId(), method: "early", value: null })
  expect(await c.event("rejected")).toMatchObject({ code: "closed" })
  // init gates the loader; a request while loading is still not admitted.
  c.emit({ ...envelope, type: "init", value: { entry: "/ext" } })
  loaded({
    async request(_method, value, signal) {
      requests++
      entered()
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      return value
    },
    async dispose() {},
  })
  await c.event("ready")
  expect(requests).toBe(0)
  const first = requestId()
  c.emit({ ...envelope, type: "request", requestId: first, method: "hold", value: "late" })
  await requesting
  c.emit({ ...envelope, type: "request", requestId: requestId(), method: "full", value: null })
  expect(await c.event("rejected")).toMatchObject({ code: "capacity" })
  c.emit({ ...envelope, type: "cancel", requestId: first })
  expect(await c.event("rejected")).toMatchObject({ code: "cancelled", requestId: first })
  c.emit({ ...envelope, type: "drain" })
  await c.event("drained")
  c.emit({ ...envelope, type: "dispose" })
  await c.event("disposed")
  expect(await serving).toBe("disposed")
  expect(c.removed()).toBe(1)
  expect(requests).toBe(1)
})

test("load receives the init payload and requests before init stay closed", async () => {
  const identity = testIdentity()
  const c = fakeChannel()
  let seenInit: unknown
  const envelope = { version: 1 as const, identity }
  const serving = serveWorker({
    identity,
    channel: c.channel,
    report() {},
    async load(init) {
      seenInit = init
      return { request: async (_m, v) => v }
    },
  })
  await c.event("hello")
  c.emit({ ...envelope, type: "request", requestId: requestId(), method: "echo", value: null })
  expect(await c.event("rejected")).toMatchObject({ code: "closed" })
  c.emit({ ...envelope, type: "init", value: { entry: "/ext", settings: { a: 1 } } })
  await c.event("ready")
  expect(seenInit).toEqual({ entry: "/ext", settings: { a: 1 } })
  c.emit({ ...envelope, type: "request", requestId: requestId(), method: "echo", value: "ok" })
  expect(await c.event("result")).toMatchObject({ value: "ok" })
  c.emit({ ...envelope, type: "dispose" })
  await c.event("disposed")
  expect(await serving).toBe("disposed")
})

test("host.call resolves on host.result and rejects on host.rejected", async () => {
  const identity = testIdentity()
  const c = fakeChannel()
  const envelope = { version: 1 as const, identity }
  const serving = serveWorker({
    identity,
    channel: c.channel,
    report() {},
    async load(_init, host) {
      return {
        request: async (method, value) => {
          if (method === "ask") return host.call("tool.ask", value)
          return host.call("tool.deny", value)
        },
      }
    },
  })
  await c.event("hello")
  c.emit({ ...envelope, type: "init", value: null })
  await c.event("ready")
  c.emit({ ...envelope, type: "request", requestId: requestId(), method: "ask", value: { q: 1 } })
  const call = await c.event("host.call")
  if (call.type !== "host.call") throw new Error("Missing host.call")
  expect(call).toMatchObject({ method: "tool.ask", value: { q: 1 } })
  c.emit({ ...envelope, type: "host.result", callId: call.callId, value: { answer: 42 } })
  expect(await c.event("result")).toMatchObject({ value: { answer: 42 } })

  c.emit({ ...envelope, type: "request", requestId: requestId(), method: "deny", value: null })
  const denied = await c.event("host.call")
  if (denied.type !== "host.call") throw new Error("Missing host.call")
  c.emit({ ...envelope, type: "host.rejected", callId: denied.callId, code: "denied", message: "blocked" })
  // The denied code propagates back to the host instead of collapsing to requestFailed.
  expect(await c.event("rejected")).toMatchObject({ code: "denied" })
  c.emit({ ...envelope, type: "dispose" })
  await c.event("disposed")
  expect(await serving).toBe("disposed")
})

test("host notify commands reach the application only after ready", async () => {
  const identity = testIdentity()
  const c = fakeChannel()
  const envelope = { version: 1 as const, identity }
  const seen: unknown[] = []
  const serving = serveWorker({
    identity,
    channel: c.channel,
    report() {},
    async load() {
      return {
        request: async (_m, v) => v,
        notify: (method, value) => {
          seen.push([method, value])
        },
      }
    },
  })
  await c.event("hello")
  c.emit({ ...envelope, type: "notify", method: "early", value: 0 })
  c.emit({ ...envelope, type: "init", value: null })
  await c.event("ready")
  c.emit({ ...envelope, type: "notify", method: "progress", value: 0.5 })
  await Promise.resolve()
  expect(seen).toEqual([["progress", 0.5]])
  c.emit({ ...envelope, type: "dispose" })
  await c.event("disposed")
  expect(await serving).toBe("disposed")
})

test("foreign-fenced commands and a duplicate init fail closed", async () => {
  const identity = testIdentity()
  const c = fakeChannel()
  const envelope = { version: 1 as const, identity }
  const serving = serveWorker({
    identity,
    channel: c.channel,
    report() {},
    async load() {
      return { request: async (_m, v) => v }
    },
  })
  await c.event("hello")
  // A frame for another runtime generation is discarded, not answered.
  c.emit({ ...envelope, identity: { ...identity, epoch: 7 }, type: "request", requestId: requestId(), method: "x", value: null })
  await Promise.resolve()
  expect(c.events).toHaveLength(0)
  c.emit({ ...envelope, type: "init", value: null })
  c.emit({ ...envelope, type: "init", value: null })
  expect(await c.event("failed")).toMatchObject({ phase: "protocol" })
  expect(await serving).toBe("failed")
})

test("control-channel loss exits the worker through the disconnect hook", async () => {
  const identity = testIdentity()
  const c = fakeChannel()
  let exited = 0
  const serving = serveWorker({
    identity,
    channel: c.channel,
    report() {},
    disconnect: () => {
      exited++
    },
    async load() {
      return { request: async (_m, v) => v }
    },
  })
  serving.catch(() => {})
  await c.event("hello")
  c.disconnect()
  expect(exited).toBe(1)
  // Without a disconnect hook the serve completes as failed instead.
  const c2 = fakeChannel()
  const serving2 = serveWorker({
    identity,
    channel: c2.channel,
    report() {},
    async load() {
      return { request: async (_m, v) => v }
    },
  })
  await c2.event("hello")
  c2.disconnect()
  expect(await serving2).toBe("failed")
})
