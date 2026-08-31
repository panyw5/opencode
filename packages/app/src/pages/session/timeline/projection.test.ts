import { describe, expect, test } from "bun:test"
import { messageAnchorRowIndices, type TimelineRowMessageIdentity } from "./message-anchor"

describe("messageAnchorRowIndices", () => {
  test("skips the turn gap before a user message", () => {
    const rows: TimelineRowMessageIdentity[] = [
      { _tag: "TurnGap", userMessageID: "user-2" },
      { _tag: "UserMessage", userMessageID: "user-2", anchor: true },
    ]

    expect(messageAnchorRowIndices(rows).get("user-2")).toBe(1)
  })

  test("uses the comment strip when it is the message anchor", () => {
    const rows: TimelineRowMessageIdentity[] = [
      { _tag: "TurnGap", userMessageID: "user-2" },
      { _tag: "CommentStrip", userMessageID: "user-2" },
      { _tag: "UserMessage", userMessageID: "user-2", anchor: false },
    ]

    expect(messageAnchorRowIndices(rows).get("user-2")).toBe(1)
  })

  test("does not use a user row that is not marked as an anchor", () => {
    const rows: TimelineRowMessageIdentity[] = [{ _tag: "UserMessage", userMessageID: "user-2", anchor: false }]

    expect(messageAnchorRowIndices(rows).has("user-2")).toBe(false)
  })
})
