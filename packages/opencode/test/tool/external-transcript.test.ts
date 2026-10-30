import { describe, expect, test } from "bun:test"
import { applyCodexJsonlLine, createCodexLiveState } from "@/tool/codex_consult"
import { applyClaudeJsonlLine, createClaudeLiveState } from "@/tool/claude_consult"
import { applyGrokJsonlLine, beginGrokTurn, createGrokLiveState } from "@/tool/grok_consult"
import { attachExternalTranscript, type TranscriptItem } from "@/session/external"

describe("external transcript capture", () => {
  test("Grok resume keeps replies isolated and clears the previous turn error", () => {
    const state = createGrokLiveState()
    beginGrokTurn(state)
    applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "First answer" }))
    applyGrokJsonlLine(state, JSON.stringify({ type: "error", message: "old error" }))
    beginGrokTurn(state)
    applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: "Second answer" }))
    expect(state.assistantText).toBe("Second answer")
    expect(state.error).toBeUndefined()
    expect(state.runSeq).toBe(2)
  })
  const full = "a".repeat(16000)
  for (const advisor of ["codex", "claude", "grok"] as const) {
    test(`${advisor} captures full replies before capping the compatibility transcript`, () => {
      const captured = new Map<string, TranscriptItem>()
      const context = {
        extra: {
          externalTranscript: (item: TranscriptItem) => captured.set(item.id, { ...captured.get(item.id), ...item }),
        },
      }
      if (advisor === "codex") {
        const state = createCodexLiveState()
        attachExternalTranscript(context, state)
        for (let index = 0; index < 100; index++) {
          applyCodexJsonlLine(
            state,
            JSON.stringify({
              type: "item.completed",
              item: { id: `reply:${index}`, type: "agent_message", text: index === 0 ? full : `reply ${index}` },
            }),
          )
        }
        expect(state.transcript.length).toBeLessThanOrEqual(80)
      } else if (advisor === "claude") {
        const state = createClaudeLiveState()
        attachExternalTranscript(context, state)
        for (let index = 0; index < 100; index++) {
          applyClaudeJsonlLine(
            state,
            JSON.stringify({
              type: "assistant",
              message: {
                id: `message:${index}`,
                content: [{ type: "text", text: index === 0 ? full : `reply ${index}` }],
              },
            }),
          )
        }
        expect(state.transcript.length).toBeLessThanOrEqual(80)
      } else {
        const state = createGrokLiveState()
        attachExternalTranscript(context, state)
        applyGrokJsonlLine(state, JSON.stringify({ type: "text", data: full }))
        applyGrokJsonlLine(state, JSON.stringify({ type: "end" }))
        expect(state.transcript.find((item) => item.kind === "message")!.text!.length).toBeLessThan(full.length)
      }
      expect([...captured.values()].some((item) => item.kind === "message" && item.text === full)).toBe(true)
      if (advisor !== "grok") expect([...captured.values()].filter((item) => item.kind === "message")).toHaveLength(100)
    })
  }
})
