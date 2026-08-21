import { describe, expect, test } from "bun:test"
import { sessionDataMutation } from "./session-data-event"

describe("sessionDataMutation", () => {
  test("maps message, todo, and diff events to resource revisions", () => {
    expect(sessionDataMutation({ type: "message.updated", properties: { info: { sessionID: "s" } } }, () => undefined))
      .toEqual({ sessionID: "s", kind: "messages", strategy: "merge" })
    expect(sessionDataMutation({ type: "todo.updated", properties: { sessionID: "s" } }, () => undefined)).toEqual({
      sessionID: "s",
      kind: "todo",
      strategy: "discard",
    })
    expect(sessionDataMutation({ type: "session.diff", properties: { sessionID: "s" } }, () => undefined)).toEqual({
      sessionID: "s",
      kind: "diff",
      strategy: "discard",
    })
  })

  test("resolves part removal through its message", () => {
    expect(
      sessionDataMutation(
        { type: "message.part.removed", properties: { messageID: "m", partID: "p" } },
        (messageID) => (messageID === "m" ? "s" : undefined),
      ),
    ).toEqual({ sessionID: "s", kind: "messages", strategy: "discard" })
  })

  test("treats removals as authoritative and deltas as mergeable", () => {
    expect(
      sessionDataMutation({ type: "message.removed", properties: { sessionID: "s", messageID: "m" } }, () => undefined),
    ).toEqual({ sessionID: "s", kind: "messages", strategy: "discard" })
    expect(
      sessionDataMutation(
        { type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "p" } },
        () => undefined,
      ),
    ).toEqual({ sessionID: "s", kind: "messages", strategy: "merge" })
  })
})
