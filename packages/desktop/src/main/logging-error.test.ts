import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { brokenConsoleCode, guardBrokenConsoleStream } from "./logging-error"

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

  test("handles asynchronous broken stream errors", () => {
    const stream = new EventEmitter()
    const codes: string[] = []
    guardBrokenConsoleStream(stream, (code) => codes.push(code))

    stream.emit("error", { code: "EIO" })
    stream.emit("error", { code: "EPIPE" })

    expect(codes).toEqual(["EIO", "EPIPE"])
  })

  test("does not hide unrelated stream errors", () => {
    const stream = new EventEmitter()
    guardBrokenConsoleStream(stream, () => {})

    expect(() => stream.emit("error", { code: "ENOENT" })).toThrow()
  })
})
