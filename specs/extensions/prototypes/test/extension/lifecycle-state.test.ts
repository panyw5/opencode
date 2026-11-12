import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import {
  acceptsRuntime,
  admitRuntime,
  closeAdmission,
  decodeAdmission,
  LifecycleStateError,
  recordRuntimeState,
  RuntimeIdentity,
} from "../../src/extension/lifecycle-state"
import { decodeExecutionCommand, decodeExecutionEvent } from "../../src/extension/execution-protocol"
import { executionIdentity } from "./execution-fixture"

test("readiness is required for business effects and closing admission fences every registered execution", () => {
  const { snapshot, identity, operationId } = executionIdentity()
  const starting = admitRuntime(snapshot, snapshot, identity)
  expect(acceptsRuntime(starting, identity)).toBe(false)
  const ready = recordRuntimeState(starting, starting, identity, "ready")
  expect(acceptsRuntime(ready, identity)).toBe(true)
  const closing = closeAdmission(ready, ready, operationId)
  expect(closing.epoch).toBe(ready.epoch + 1)
  expect(closing.runtimes).toEqual(ready.runtimes)
  expect(acceptsRuntime(closing, identity)).toBe(false)
  expect(() => admitRuntime(closing, closing, identity)).toThrow(LifecycleStateError)
  expect(() => recordRuntimeState(closing, closing, identity, "ready")).toThrow(LifecycleStateError)
  expect(snapshot.revision).toBe(0)
  expect(snapshot.runtimes).toHaveLength(0)
})

test("startup and stop racing on one revision cannot both commit", () => {
  const { snapshot, identity, operationId } = executionIdentity()
  const starting = admitRuntime(snapshot, snapshot, identity)
  expect(() => closeAdmission(starting, snapshot, operationId)).toThrow(LifecycleStateError)
  const closing = closeAdmission(snapshot, snapshot, operationId)
  expect(() => admitRuntime(closing, snapshot, identity)).toThrow(LifecycleStateError)
  expect(() => admitRuntime(closing, closing, identity)).toThrow(LifecycleStateError)
})

test("root exit remains recorded across JSON recovery and cannot reopen admission", () => {
  const { snapshot, identity, operationId } = executionIdentity()
  const starting = admitRuntime(snapshot, snapshot, identity)
  const closing = closeAdmission(starting, starting, operationId)
  const exited = recordRuntimeState(closing, closing, identity, "rootExited")
  const recovered = decodeAdmission(JSON.parse(JSON.stringify(exited)))
  expect(recovered).toEqual(exited)
  expect(recovered.admission.status).toBe("closing")
  expect(recovered.runtimes[0]?.state).toBe("rootExited")
  expect(acceptsRuntime(recovered, identity)).toBe(false)
  expect(closeAdmission(recovered, recovered, operationId)).toBe(recovered)
  expect(() => recordRuntimeState(recovered, recovered, identity, "ready")).toThrow(LifecycleStateError)
})

test("foreign store, deployment, reused runtime and stale epochs are rejected", () => {
  const { snapshot, identity } = executionIdentity()
  const foreign = executionIdentity()
  const starting = admitRuntime(snapshot, snapshot, identity)
  expect(() => admitRuntime(starting, starting, identity)).toThrow(LifecycleStateError)
  expect(() => admitRuntime(snapshot, foreign.snapshot, identity)).toThrow(LifecycleStateError)
  for (const field of ["storeId", "installationId", "generationId", "runtimeId"] as const) {
    const other = Schema.decodeUnknownSync(RuntimeIdentity)({ ...identity, [field]: randomUUID() })
    expect(acceptsRuntime(starting, other)).toBe(false)
    expect(() => recordRuntimeState(starting, starting, other, "rootExited")).toThrow(LifecycleStateError)
  }
  expect(() => admitRuntime(snapshot, snapshot, { ...identity, epoch: 1 })).toThrow(LifecycleStateError)
})

test("snapshot decoding rejects unknown versions, fields, duplicate and foreign runtime records", () => {
  const { snapshot, identity } = executionIdentity()
  for (const input of [
    {},
    { ...snapshot, version: 4 },
    { ...snapshot, revision: -1 },
    { ...snapshot, epoch: 1.5 },
    { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, extra: "silently ignored" },
    { ...snapshot, runtimes: [{ identity: { ...identity, storeId: randomUUID() }, state: "starting" }] },
    {
      ...snapshot,
      runtimes: [
        { identity, state: "starting" },
        { identity, state: "ready" },
      ],
    },
  ])
    expect(() => decodeAdmission(input)).toThrow(LifecycleStateError)
})

test("revision and epoch overflow reject mutations without changing the original snapshot", () => {
  const { snapshot, identity, operationId } = executionIdentity()
  const revision = decodeAdmission({ ...snapshot, revision: Number.MAX_SAFE_INTEGER })
  expect(() => admitRuntime(revision, revision, identity)).toThrow(LifecycleStateError)
  const epoch = decodeAdmission({ ...snapshot, epoch: Number.MAX_SAFE_INTEGER })
  expect(() => closeAdmission(epoch, epoch, operationId)).toThrow(LifecycleStateError)
  expect(epoch.admission.status).toBe("open")
})

test("wire decoder rejects claimed exit, wrong versions, extra fields and non-JSON results", () => {
  const { identity } = executionIdentity()
  const base = { version: 1, identity }
  expect(decodeExecutionEvent({ ...base, type: "hello" }).type).toBe("hello")
  for (const event of [
    { ...base, type: "exit" },
    { ...base, type: "ready", version: 2 },
    { ...base, type: "ready", secret: "must not be stripped" },
    { ...base, type: "result", requestId: randomUUID(), value: Infinity },
    { ...base, type: "result", requestId: randomUUID(), value: () => 1 },
  ])
    expect(() => decodeExecutionEvent(event)).toThrow()
  expect(() =>
    decodeExecutionCommand({ ...base, type: "request", requestId: "-".repeat(36), method: "echo", value: null }),
  ).toThrow()
})
