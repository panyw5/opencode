import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import { queuedUserMessageIDs } from "./queued-message"

const user = (id: string, created: number) => ({ id, role: "user", time: { created } }) as UserMessage

const assistant = (id: string, parentID: string, created: number, completed?: number) =>
  ({ id, parentID, role: "assistant", time: { created, completed } }) as AssistantMessage

const queued = (messages: Message[]) => [...queuedUserMessageIDs(messages)]

describe("queued user messages", () => {
  test("marks user messages added after the active assistant turn", () => {
    expect(queued([user("u1", 1), assistant("a1", "u1", 2), user("u2", 3)])).toEqual(["u2"])
  })

  test("marks multiple follow-up messages while the same turn is active", () => {
    expect(queued([user("u1", 1), assistant("a1", "u1", 2), user("u2", 3), user("u3", 4)])).toEqual(["u2", "u3"])
  })

  test("clears queued state when the assistant turn completes", () => {
    expect(queued([user("u1", 1), assistant("a1", "u1", 2, 4), user("u2", 3)])).toEqual([])
  })

  test("does not mark earlier messages after processing advances to the follow-up", () => {
    expect(queued([user("u1", 1), assistant("a1", "u1", 2, 3), user("u2", 4), assistant("a2", "u2", 5)])).toEqual([])
  })

  test("ignores a stale incomplete assistant after a newer turn completes", () => {
    expect(
      queued([
        user("u1", 1),
        assistant("a1", "u1", 2),
        user("u2", 3),
        assistant("a2", "u2", 4, 5),
        user("u3", 6),
      ]),
    ).toEqual([])
  })
})
