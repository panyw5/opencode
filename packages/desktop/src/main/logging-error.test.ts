import { describe, expect, test } from "bun:test"
import { brokenConsoleCode } from "./logging-error"

describe("brokenConsoleCode", () => {
  test("accepts detached pipe and PTY error codes", () => {
    expect(brokenConsoleCode({ code: "EPIPE" })).toBe("EPIPE")
    expect(brokenConsoleCode({ code: "EIO" })).toBe("EIO")
  })

  test("rejects unrelated and malformed errors", () => {
    expect(brokenConsoleCode({ code: "ENOENT" })).toBeUndefined()
    expect(brokenConsoleCode(new Error("failed"))).toBeUndefined()
    expect(brokenConsoleCode(undefined)).toBeUndefined()
  })
})
