import { describe, expect, test } from "bun:test"
import { createSessionPill, readSessionPill } from "./session-pill"
import {
  getCursorPosition,
  getNodeLength,
  getTextLength,
  serialize,
  setCursorPosition,
  setRangeEdge,
} from "./editor-dom"

describe("session reference capsule", () => {
  const reference = {
    type: "session" as const,
    sessionID: "ses_source",
    directory: "/source",
    title: "Plan <A> & B",
    summary: "user: context",
    updatedAt: 1700000000000,
  }
  const content = `@${reference.title}`
  const part = { type: "session" as const, reference, content, start: 0, end: content.length }

  test("renders a non-editable capsule safely and round-trips the exact snapshot", () => {
    const pill = createSessionPill(part)
    expect(pill.getAttribute("contenteditable")).toBe("false")
    expect(pill.textContent).toBe(content)
    expect(pill.querySelector("a")).toBeNull()
    expect(readSessionPill(pill, 3)).toEqual({ ...part, start: 3, end: 3 + content.length })
    expect(serialize(pill)).toBe(content)
    expect(getNodeLength(pill)).toBe(content.length)
    expect(getTextLength(pill)).toBe(content.length)
  })

  test("cursor and selection treat the capsule as an atomic part", () => {
    const container = document.createElement("div")
    const pill = createSessionPill(part)
    container.append(document.createTextNode("ab"), pill, document.createTextNode(" tail"))
    document.body.append(container)
    try {
      setCursorPosition(container, 2)
      expect(getCursorPosition(container)).toBe(2)
      setCursorPosition(container, 2 + content.length)
      expect(getCursorPosition(container)).toBe(2 + content.length)
      const range = document.createRange()
      setRangeEdge(container, range, "start", 2)
      setRangeEdge(container, range, "end", 2 + content.length)
      range.deleteContents()
      expect(serialize(container)).toBe("ab tail")
    } finally {
      container.remove()
    }
  })

  test("rejects malformed snapshot data", () => {
    const pill = createSessionPill(part)
    pill.dataset.reference = "{}"
    expect(readSessionPill(pill, 0)).toBeUndefined()
    pill.dataset.reference = "not json"
    expect(readSessionPill(pill, 0)).toBeUndefined()
  })
})
