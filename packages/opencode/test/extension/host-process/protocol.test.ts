import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  decodeHostCommand,
  decodeWorkerEvent,
  HostProcessError,
  makeIdentity,
  PROTOCOL_VERSION,
  sameRuntime,
  serializeCommand,
  serializeEvent,
} from "../../../src/extension/host-process/protocol.ts"
import { testFence, testIdentity } from "./fixture.ts"

const identity = testIdentity()
const envelope = { version: PROTOCOL_VERSION, identity }
const requestId = randomUUID()
const callId = randomUUID()

describe("protocol", () => {
  const validEvents: [string, unknown][] = [
    ["hello", { ...envelope, type: "hello" }],
    ["ready", { ...envelope, type: "ready" }],
    ["drained", { ...envelope, type: "drained" }],
    ["disposed", { ...envelope, type: "disposed" }],
    ["result", { ...envelope, type: "result", requestId, value: { answer: 42 } }],
    ["rejected", { ...envelope, type: "rejected", requestId, code: "denied", message: "nope" }],
    ["rejected without message", { ...envelope, type: "rejected", requestId, code: "capacity" }],
    ["failed", { ...envelope, type: "failed", phase: "dispose" }],
    ["host.call", { ...envelope, type: "host.call", callId, method: "tool.ask", value: { q: 1 } }],
    ["notify", { ...envelope, type: "notify", method: "progress", value: [1, 2] }],
  ]
  for (const [name, frame] of validEvents)
    test(`decodes worker event ${name}`, () => {
      expect(decodeWorkerEvent(frame)).toEqual(frame)
      expect(JSON.parse(serializeEvent(decodeWorkerEvent(frame)))).toEqual(frame)
    })

  const validCommands: [string, unknown][] = [
    ["init", { ...envelope, type: "init", value: { entry: "/x", settings: null } }],
    ["request", { ...envelope, type: "request", requestId, method: "echo", value: "v" }],
    ["cancel", { ...envelope, type: "cancel", requestId }],
    ["drain", { ...envelope, type: "drain" }],
    ["dispose", { ...envelope, type: "dispose" }],
    ["host.result", { ...envelope, type: "host.result", callId, value: { yes: true } }],
    ["host.rejected", { ...envelope, type: "host.rejected", callId, code: "denied", message: "blocked" }],
    ["notify", { ...envelope, type: "notify", method: "session.updated", value: null }],
  ]
  for (const [name, frame] of validCommands)
    test(`decodes host command ${name}`, () => {
      expect(decodeHostCommand(frame)).toEqual(frame)
      expect(JSON.parse(serializeCommand(decodeHostCommand(frame)))).toEqual(frame)
    })

  const invalid: [string, unknown][] = [
    ["wrong version", { ...envelope, version: 2, type: "hello" }],
    ["missing version", { identity, type: "hello" }],
    ["unknown field", { ...envelope, type: "hello", extra: true }],
    ["unknown type", { ...envelope, type: "restart" }],
    ["malformed uuid", { ...envelope, type: "result", requestId: "not-a-uuid", value: null }],
    ["uppercase uuid", { ...envelope, type: "result", requestId: requestId.toUpperCase(), value: null }],
    ["negative epoch", { ...envelope, identity: { ...identity, epoch: -1 }, type: "hello" }],
    ["fractional generation", { ...envelope, identity: { ...identity, generation: 0.5 }, type: "hello" }],
    ["non-json value", { ...envelope, type: "result", requestId, value: undefined }],
    ["reversed channel", { ...envelope, type: "host.result", callId, value: null }],
  ]
  for (const [name, frame] of invalid)
    test(`rejects event with ${name}`, () => {
      expect(() => decodeWorkerEvent(frame)).toThrow(HostProcessError)
      try {
        decodeWorkerEvent(frame)
      } catch (error) {
        expect((error as HostProcessError).code).toBe("protocol")
      }
    })

  test("rejects commands arriving on the wrong direction", () => {
    for (const frame of [
      { ...envelope, type: "request", requestId, method: "x", value: null },
      { ...envelope, type: "init", value: null },
    ])
      expect(() => decodeWorkerEvent(frame)).toThrow(HostProcessError)
    for (const frame of [
      { ...envelope, type: "result", requestId, value: null },
      { ...envelope, type: "host.call", callId, method: "x", value: null },
    ])
      expect(() => decodeHostCommand(frame)).toThrow(HostProcessError)
  })

  test("rejected codes are the closed vocabulary", () => {
    for (const code of ["closed", "cancelled", "requestFailed", "capacity", "denied"])
      expect(decodeWorkerEvent({ ...envelope, type: "rejected", requestId, code })).toMatchObject({ code })
    expect(() => decodeWorkerEvent({ ...envelope, type: "rejected", requestId, code: "mystery" })).toThrow(
      HostProcessError,
    )
  })

  test("sameRuntime compares the complete fence, never just the runtime", () => {
    const a = testIdentity()
    const b = testIdentity(a)
    expect(sameRuntime(a, b)).toBe(false) // different runtime minted per launch
    expect(sameRuntime(a, { ...a })).toBe(true)
    for (const [field, value] of [
      ["store", randomUUID()],
      ["installation", randomUUID()],
      ["generation", 1],
      ["runtime", randomUUID()],
      ["epoch", 1],
    ] as const)
      expect(sameRuntime(a, { ...a, [field]: value })).toBe(false)
  })

  test("makeIdentity keeps durable fence fields and mints a fresh runtime per launch", () => {
    const fence = testFence()
    const one = makeIdentity(fence)
    const two = makeIdentity(fence)
    expect(one.store).toBe(fence.store)
    expect(one.installation).toBe(fence.installation)
    expect(one.generation).toBe(fence.generation)
    expect(one.epoch).toBe(fence.epoch)
    expect(one.runtime).not.toBe(two.runtime)
  })
})
