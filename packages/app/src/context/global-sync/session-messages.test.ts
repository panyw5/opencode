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
    const result = mergeOptimisticSessionPage({ session: [], part: [], complete: true }, [
      { message: optimistic, parts: [] },
    ])
    expect(result.session).toEqual([optimistic])
    expect(result.confirmed).toEqual([])
  })

  test("confirms persisted attachment messages even when the backend replaces their parts", () => {
    const persisted = message("message")
    const attachment = {
      id: "pdf-input",
      sessionID: "session",
      messageID: persisted.id,
      type: "file",
      mime: "application/pdf",
      filename: "slides.pdf",
      url: "file:///tmp/slides.pdf",
    } as Part
    const fetched = [text("Extracted PDF content")]
    const result = mergeOptimisticSessionPage(
      { session: [persisted], part: [{ id: persisted.id, part: fetched }], complete: true },
      [{ message: persisted, parts: [attachment] }],
    )
    expect(result.confirmed).toEqual([persisted.id])
    expect(result.part).toEqual([{ id: persisted.id, part: fetched }])
  })
})
