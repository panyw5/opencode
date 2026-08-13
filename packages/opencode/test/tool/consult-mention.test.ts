import { describe, expect, test } from "bun:test"
import {
  buildConsultFollowupSynthetic,
  buildConsultPromptFromParts,
  consultMentionFor,
  CONSULT_MENTION_IDS,
  isConsultMention,
  isConsultTool,
} from "../../src/tool/consult-mention"

describe("consult-mention", () => {
  test("recognizes reserved consult ids only", () => {
    for (const id of CONSULT_MENTION_IDS) {
      expect(isConsultMention(id)).toBe(true)
    }
    expect(isConsultMention("explore")).toBe(false)
    expect(isConsultMention("Codex")).toBe(false)
    expect(isConsultMention("codex_consult")).toBe(false)
  })

  test("maps ids to consult tools", () => {
    expect(consultMentionFor("codex")).toEqual({
      id: "codex",
      tool: "codex_consult",
      label: "Codex",
    })
    expect(consultMentionFor("claude")?.tool).toBe("claude_consult")
    expect(consultMentionFor("grok")?.tool).toBe("grok_consult")
    expect(consultMentionFor("dsh")?.tool).toBe("dsh_consult")
    expect(consultMentionFor("dsh")?.label).toBe("DeepSeek")
    expect(consultMentionFor("planner")).toBeUndefined()
  })

  test("isConsultTool matches tool ids", () => {
    expect(isConsultTool("codex_consult")).toBe(true)
    expect(isConsultTool("dsh_consult")).toBe(true)
    expect(isConsultTool("task")).toBe(false)
  })

  test("buildConsultPromptFromParts uses user text and file paths", () => {
    const prompt = buildConsultPromptFromParts([
      { type: "text", text: "  Review the auth race  ", synthetic: false },
      { type: "text", text: "ignored synthetic", synthetic: true },
      { type: "file", filename: "auth.ts", source: { path: "/repo/src/auth.ts" } },
      { type: "agent", name: "codex" },
    ])
    expect(prompt).toContain("Review the auth race")
    expect(prompt).toContain("/repo/src/auth.ts")
    expect(prompt).not.toContain("ignored synthetic")
  })

  test("buildConsultPromptFromParts falls back to files only", () => {
    const prompt = buildConsultPromptFromParts([
      { type: "file", filename: "a.ts", source: { path: "/a.ts" } },
    ])
    expect(prompt).toBe("Referenced files:\n- /a.ts")
  })

  test("follow-up synthetic mentions advisors and forbids re-invoke", () => {
    const text = buildConsultFollowupSynthetic(["codex", "claude"])
    expect(text).toContain("Codex")
    expect(text).toContain("Claude")
    expect(text).toContain("Do not re-invoke")
  })
})
