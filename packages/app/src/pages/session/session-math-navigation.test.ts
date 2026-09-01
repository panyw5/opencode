import { describe, expect, test } from "bun:test"
import { leaveMathDetailsForWorker } from "./session-math-navigation"

describe("leaveMathDetailsForWorker", () => {
  test("closes the Math Mode details before opening a worker session", () => {
    const calls: string[] = []

    leaveMathDetailsForWorker({
      close: () => calls.push("close"),
      open: () => calls.push("open"),
    })

    expect(calls).toEqual(["close", "open"])
  })
})
