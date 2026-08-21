import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { mergeFetchedSessionParts, mergeOptimisticSessionPage, mergeSessionItems } from "./session-messages"

const message = (id: string, completed?: number) =>
  ({ id, sessionID: "session", role: "assistant", time: { created: 1, completed } }) as Message

const text = (value: string) =>
  ({ id: "part", sessionID: "session", messageID: "message", type: "text", text: value }) as Part

describe("session messages", () => {
  test("lets current SSE data win when merging a fetched snapshot", () => {
    const fetched = message("message", 1)
    const current = message("message", 2)
    expect(mergeSessionItems([fetched], [current])).toEqual([current])
  })

  test("keeps longer streaming text over a stale snapshot", () => {
    const current = text("hello world")
    expect(mergeFetchedSessionParts([text("hello")], [current])).toEqual([current])
  })

  test("keeps an optimistic message missing from the fetched page", () => {
    const optimistic = message("optimistic")
    const result = mergeOptimisticSessionPage(
      { session: [], part: [], complete: true },
      [{ message: optimistic, parts: [] }],
    )
    expect(result.session).toEqual([optimistic])
    expect(result.confirmed).toEqual([])
  })
})
