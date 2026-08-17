import { describe, expect, test } from "bun:test"

import { isAddressInUseError, startWithPortRetry } from "./startup-retry"

describe("startWithPortRetry", () => {
  test("reallocates a port after an address-in-use failure", async () => {
    const ports = [4100, 4101]
    const attempts: number[] = []
    const result = await startWithPortRetry({
      component: "WSL sidecar",
      allocatePort: async () => ports.shift()!,
      start: async (port) => {
        attempts.push(port)
        if (port === 4100) throw new Error("listen EADDRINUSE: address already in use 127.0.0.1:4100")
        return port
      },
    })

    expect(result).toBe(4101)
    expect(attempts).toEqual([4100, 4101])
  })

  test("does not retry non-binding startup failures", async () => {
    let allocations = 0
    const error = await startWithPortRetry({
      component: "Extra-agent bridge",
      allocatePort: async () => ++allocations,
      start: async () => {
        throw new Error("invalid configuration")
      },
    }).catch((error) => error)

    expect(allocations).toBe(1)
    expect(error.message).toContain("invalid configuration")
  })

  test("reports exhaustion after bounded binding retries", async () => {
    let allocations = 0
    const error = await startWithPortRetry({
      component: "WSL sidecar for Debian",
      attempts: 2,
      allocatePort: async () => ++allocations,
      start: async (port) => {
        throw new Error(`Address already in use: ${port}`)
      },
    }).catch((error) => error)

    expect(allocations).toBe(2)
    expect(error.message).toContain("WSL sidecar for Debian failed to start after 2 attempts")
  })

  test("coerces a non-positive attempt budget to a single attempt", async () => {
    let allocations = 0
    const error = await startWithPortRetry({
      component: "WSL sidecar",
      attempts: 0,
      allocatePort: async () => ++allocations,
      start: async (port) => {
        throw new Error(`Address already in use: ${port}`)
      },
    }).catch((error) => error)

    expect(allocations).toBe(1)
    expect(error.message).toContain("failed to start after 1 attempt:")
    expect(error.message).not.toContain("1 attempts")
  })

  test("succeeds on the final attempt and passes attempt numbers through", async () => {
    const seen: Array<{ port: number; attempt: number }> = []
    const result = await startWithPortRetry({
      component: "WSL sidecar",
      attempts: 3,
      allocatePort: async () => 4200 + seen.length,
      start: async (port, attempt) => {
        seen.push({ port, attempt })
        if (attempt < 3) throw new Error("listen EADDRINUSE: address already in use")
        return port
      },
    })

    expect(result).toBe(4202)
    expect(seen.map((entry) => entry.attempt)).toEqual([1, 2, 3])
  })

  test("preserves the original error as cause on exhaustion", async () => {
    const original = new Error("Address already in use")
    const error = await startWithPortRetry({
      component: "WSL sidecar",
      attempts: 1,
      allocatePort: async () => 4300,
      start: async () => {
        throw original
      },
    }).catch((error) => error)

    expect(error.cause).toBe(original)
  })
})

test("recognizes Windows socket binding errors", () => {
  expect(isAddressInUseError(new Error("Only one usage of each socket address is normally permitted"))).toBe(true)
})
