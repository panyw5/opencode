import { afterEach, describe, expect, test } from "bun:test"
import { Env } from "../../src/pty/env"

const keys = ["OPENCODE_TEST_REMOVED_ENV", "OPENCODE_TEST_NEW_ENV"]
const original = new Map(keys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("PTY environment", () => {
  test("does not merge live process values into a resolved snapshot", () => {
    process.env.OPENCODE_TEST_REMOVED_ENV = "must-not-return"
    delete process.env.OPENCODE_TEST_NEW_ENV

    const inspected = Env.prepare({ inherit: true, plugin: { OPENCODE_TEST_REMOVED_ENV: undefined } })
    expect(inspected.OPENCODE_TEST_REMOVED_ENV).toBeUndefined()

    delete process.env.OPENCODE_TEST_REMOVED_ENV
    process.env.OPENCODE_TEST_NEW_ENV = "must-not-appear"
    const spawned = Env.prepare({ env: inspected, inherit: false })

    expect(spawned.OPENCODE_TEST_REMOVED_ENV).toBeUndefined()
    expect(spawned.OPENCODE_TEST_NEW_ENV).toBeUndefined()
    expect(spawned.TERM).toBe("xterm-256color")
    expect(spawned.OPENCODE_TERMINAL).toBe("1")
  })
})
