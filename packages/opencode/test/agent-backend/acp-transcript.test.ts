import { describe, expect, test } from "bun:test"
import { AcpTranscript } from "../../src/agent-backend/acp-transcript"
import type { AgentEvent } from "../../src/agent-backend/backend"

describe("ACP normalized transcript", () => {
  test("persists full patches before clipping previews and keeps status-only updates lossless", () => {
    const live = new AcpTranscript()
    const captured = new Map<string, AgentEvent>()
    live.onTranscript = (item) => captured.set(item.id, { ...captured.get(item.id), ...item })
    live.beginTurn("initial")
    const full = "a".repeat(16000)
    live.apply({
      sessionId: "fixture",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read",
        title: "Read",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: full } }],
      },
    })
    live.apply({
      sessionId: "fixture",
      update: { sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed" },
    })
    expect(captured.get("1:tool:read")).toMatchObject({ text: full, status: "completed", title: "Read" })
    expect(live.transcript[0]?.text?.length).toBe(8000)
    for (let i = 0; i < 100; i++)
      live.apply({
        sessionId: "fixture",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: String(i),
          title: "Tool",
          status: "completed",
        },
      })
    expect(live.transcript).toHaveLength(80)
    expect(captured.size).toBe(101)
  })
})
