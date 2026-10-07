import { describe, expect, test } from "bun:test"
import { appendSelectionToPrompt } from "./selection-prompt"
import type { Prompt } from "@/context/prompt"

describe("selection prompt append", () => {
  test("adds to an empty draft without leading whitespace", () => {
    const next = appendSelectionToPrompt([{ type: "text", content: "", start: 0, end: 0 }], "**selected**")
    expect(next.cursor).toBe(12)
    expect(next.prompt.at(-1)).toEqual({ type: "text", content: "**selected**", start: 0, end: 12 })
  })
  test("preserves existing mentions and images without mutating the draft", () => {
    const draft: Prompt = [
      { type: "agent", name: "build", content: "@build", start: 0, end: 6 },
      { type: "image", id: "image", filename: "a.png", mime: "image/png", dataUrl: "data:" },
    ]
    const next = appendSelectionToPrompt(draft, "selected")
    expect(next.prompt.slice(0, 2)).toEqual(draft)
    expect(next.prompt.at(-1)).toEqual({ type: "text", content: "\n\nselected", start: 6, end: 16 })
    expect(next.cursor).toBe(16)
    expect(draft).toHaveLength(2)
  })
})
