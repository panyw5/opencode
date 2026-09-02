import { describe, expect, test } from "bun:test"
import { historyPageResult } from "./session-history-pagination"

describe("historyPageResult", () => {
  test("continues across pages containing only orphan assistant messages", () => {
    expect(historyPageResult({ loaded: 80, nextLoaded: 120, visibleBefore: 2, visibleAfter: 2, more: true })).toBe(
      "continue",
    )
  })

  test("stops once an older user turn becomes renderable", () => {
    expect(historyPageResult({ loaded: 160, nextLoaded: 183, visibleBefore: 2, visibleAfter: 3, more: false })).toBe(
      "renderable-growth",
    )
  })

  test("stops safely when pagination makes no progress", () => {
    expect(historyPageResult({ loaded: 120, nextLoaded: 120, visibleBefore: 2, visibleAfter: 2, more: true })).toBe(
      "stalled",
    )
  })

  test("stops at history completion without renderable growth", () => {
    expect(historyPageResult({ loaded: 160, nextLoaded: 183, visibleBefore: 2, visibleAfter: 2, more: false })).toBe(
      "complete",
    )
  })
})
