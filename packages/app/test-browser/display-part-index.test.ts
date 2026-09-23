import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import { createDisplayPartIndex } from "../src/pages/session/timeline/model"

const tool = (id: string, status: "running" | "completed"): ToolPart => ({
  id,
  messageID: "message",
  sessionID: "session",
  callID: "same-call",
  type: "tool",
  tool: "bash",
  state:
    status === "running"
      ? { status, input: {}, time: { start: 1 } }
      : { status, input: {}, title: "done", output: "done", metadata: {}, time: { start: 1, end: 2 } },
})

test("part index follows canonical duplicate changes and releases removed messages", () => {
  createRoot((dispose) => {
    const [state, setState] = createStore({
      messages: [{ id: "message", role: "assistant" } as Message],
      parts: [tool("first", "running"), tool("second", "completed")] as Part[],
    })
    let projections = 0
    const index = createDisplayPartIndex(
      () => state.messages,
      () => {
        projections++
        return state.parts
      },
    )
    expect(index.part("message", "first")).toBeUndefined()
    expect(index.part("message", "second")?.id).toBe("second")
    const before = projections
    for (let i = 0; i < 100; i++) index.part("message", "second")
    expect(projections).toBe(before)
    setState("parts", 0, tool("first", "completed"))
    expect(index.parts("message").map((p) => p.id)).toEqual(["first"])
    expect(index.part("message", "second")).toBeUndefined()
    setState("parts", state.parts.length, {
      id: "text",
      messageID: "message",
      sessionID: "session",
      type: "text",
      text: "a",
    })
    expect(index.part("message", "text")?.type).toBe("text")
    setState("parts", 2, "text", "streamed")
    expect((index.part("message", "text") as { text: string }).text).toBe("streamed")
    setState("messages", [])
    expect(index.parts("message")).toEqual([])
    expect(index.part("message", "first")).toBeUndefined()
    console.info(`[display-part-index-test] repeatedLookups=100 extraProjections=0 duplicateUpdates=true`)
    dispose()
  })
})
