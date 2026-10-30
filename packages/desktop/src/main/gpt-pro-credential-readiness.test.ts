import { expect, test } from "bun:test"
import { createGptProCredentialReadiness } from "./gpt-pro-credential-readiness"

test("failed initialization remains failed until an explicit coalesced recovery replaces ready", async () => {
  let initialized = false
  let fail = true
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const readiness = createGptProCredentialReadiness({
    initialize: async () => {
      calls++
      if (fail) throw Error("secure initialization fault")
      await gate
      initialized = true
    },
    initialized: () => initialized,
    persist: async () => {},
    initializationFailed: (cause) => {
      throw cause
    },
  })
  await expect(readiness.ready()).rejects.toThrow("secure initialization fault")
  fail = false
  await expect(readiness.ready()).rejects.toThrow("secure initialization fault")
  const a = readiness.recover(),
    b = readiness.recover()
  expect(a).toBe(b)
  release()
  await readiness.ready()
  expect(calls).toBe(2)
  expect(initialized).toBe(true)
})

test("storage fault recovery persists the active jar without rerunning initialization", async () => {
  let initialized = false
  let reads = 0,
    writes = 0
  let fail = true
  const readiness = createGptProCredentialReadiness({
    initialize: async () => {
      reads++
      initialized = true
    },
    initialized: () => initialized,
    persist: async () => {
      writes++
      if (fail) throw Error("storage fault")
    },
    initializationFailed: (cause) => {
      throw cause
    },
  })
  await readiness.ready()
  await expect(readiness.recover()).rejects.toThrow("storage fault")
  fail = false
  await expect(readiness.ready()).rejects.toThrow("storage fault")
  await readiness.recover()
  await readiness.ready()
  expect(reads).toBe(1)
  expect(writes).toBe(2)
})
