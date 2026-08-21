import { describe, expect, test } from "bun:test"
import { sessionStatusHistoryKey } from "./session-status-history"

describe("sessionStatusHistoryKey", () => {
  test("is stable when child session order or array identity changes", () => {
    const first = sessionStatusHistoryKey("parent", ["child-b", "child-a", "child-a"])
    const second = sessionStatusHistoryKey("parent", ["child-a", "child-b"])
    expect(first).toBe(second)
  })

  test("changes with the current session or child set", () => {
    expect(sessionStatusHistoryKey("parent-a", ["child"])).not.toBe(
      sessionStatusHistoryKey("parent-b", ["child"]),
    )
    expect(sessionStatusHistoryKey("parent", ["child-a"])).not.toBe(
      sessionStatusHistoryKey("parent", ["child-b"]),
    )
  })
})
