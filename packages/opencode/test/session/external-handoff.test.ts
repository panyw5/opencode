import { describe, expect, test } from "bun:test"
import { externalConversationOutput } from "@/session/external-handoff"
import type { MessageV2 } from "@/session/message-v2"

const message = (role: "user" | "assistant", text: string): MessageV2.WithParts =>
  ({
    info: { role },
    parts: [{ type: "text", text }],
  }) as MessageV2.WithParts

const input = {
  advisor: "codex" as const,
  sessionID: "ses_external_child",
  messages: [
    message("user", "News?"),
    message("assistant", "First news"),
    message("user", "Science?"),
    message("assistant", "Science report"),
    message("user", "Eaten?"),
    message("assistant", "I do not eat."),
  ],
  output: "<codex_consult>\nthread_id: cli-thread-123\n</codex_consult>\n\nI do not eat.",
}

describe("external consultation handoff protocol", () => {
  test("returns a versioned child reference, bounded previews and an actionable transcript call", () => {
    const result = externalConversationOutput(input)
    expect(result.handoff).toEqual({
      version: 1,
      advisor: "codex",
      task_id: "ses_external_child",
      user_intervened: true,
      user_turns: 3,
      read_before_summary: true,
      delivery: "reference",
      summary: {
        original_request: "News?",
        initial_answer: "First news",
        latest_request: "Eaten?",
        latest_answer: "I do not eat.",
      },
      read_transcript: {
        tool: "task_transcript",
        arguments: { task_id: "ses_external_child", include: ["text"], limit: 20 },
      },
    })
    const block = result.output.match(/<external_consultation>\n([\s\S]*?)\n<\/external_consultation>/)
    expect(JSON.parse(block![1]!)).toEqual(result.handoff)
    expect(result.output).toContain("cli-thread-123")
    expect(result.output).toContain("MUST call task_transcript")
    expect(result.output).toContain("next_cursor")
    expect(result.output).not.toContain("Science report")
    expect(result.output).not.toContain("<consultation_history>")
  })

  test("retains the original single-turn answer while providing its child reference", () => {
    const result = externalConversationOutput({
      ...input,
      messages: input.messages.slice(0, 2),
      output: "Original answer",
    })
    expect(result.handoff).toMatchObject({
      task_id: input.sessionID,
      user_intervened: false,
      user_turns: 1,
      read_before_summary: false,
    })
    expect(result.output.endsWith("\n\nOriginal answer")).toBe(true)
  })

  test("records intervention activation even if the user never adds a second message", () => {
    const result = externalConversationOutput({ ...input, messages: input.messages.slice(0, 2), userIntervened: true })
    expect(result.handoff).toMatchObject({ user_intervened: true, user_turns: 1, read_before_summary: true })
  })

  test("falls back to complete text history when transcript reading is disabled", () => {
    const result = externalConversationOutput({ ...input, transcriptAvailable: false })
    expect(result.handoff).toMatchObject({
      delivery: "inline_fallback",
      user_intervened: true,
      read_before_summary: false,
    })
    expect(result.output).toContain("<consultation_history>")
    expect(result.output).toContain("Science report")
    expect(result.output).toContain("Science?")
    expect(result.output).toContain("task_transcript is unavailable")
    expect(result.output).not.toContain("MUST call task_transcript")
  })

  test("does not expose reasoning, diagnostics or hidden text in summary previews", () => {
    const answer = message("assistant", "Final answer")
    answer.parts.push({ type: "reasoning", text: "private thought" } as MessageV2.ReasoningPart)
    answer.parts.push({ type: "text", text: "hidden synthetic", synthetic: true } as MessageV2.TextPart)
    answer.parts.push({ type: "text", text: "ignored text", ignored: true } as MessageV2.TextPart)
    const result = externalConversationOutput({
      ...input,
      messages: [message("user", "Request"), answer],
      userIntervened: true,
    })
    expect(result.handoff.summary.initial_answer).toBe("Final answer")
    expect(result.output).not.toContain("private thought")
    expect(result.output).not.toContain("hidden synthetic")
    expect(result.output).not.toContain("ignored text")
  })

  test("keeps protocol references outside bounded previews of arbitrarily long replies", () => {
    const result = externalConversationOutput({
      ...input,
      messages: [
        message("user", "u".repeat(20000)),
        message("assistant", "a".repeat(20000)),
        ...input.messages.slice(2),
      ],
    })
    expect(result.output.length).toBeLessThan(5000)
    expect(result.handoff.summary.original_request.length).toBeLessThan(450)
    expect(result.handoff.summary.initial_answer.length).toBeLessThan(850)
    expect(result.handoff.read_transcript.arguments.task_id).toBe(input.sessionID)
    expect(result.output).toContain("[preview truncated]")
  })
})
