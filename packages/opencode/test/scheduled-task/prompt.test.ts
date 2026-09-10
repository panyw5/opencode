import { describe, expect, test } from "bun:test"
import { ScheduledTaskPrompt } from "@/scheduled-task/prompt"
import { SessionID } from "@/session/schema"

describe("ScheduledTaskPrompt", () => {
  test("injects only the previous session ID before a rotated task prompt", () => {
    const previousSessionID = SessionID.make("ses_previous")

    expect(ScheduledTaskPrompt.injectedPrompt({ prompt: "Review the workspace", previousSessionID })).toBe(
      '<scheduled-task-context previous_session_id="ses_previous" />\n\nReview the workspace',
    )
  })

  test("leaves unrelated task prompts unchanged", () => {
    expect(ScheduledTaskPrompt.injectedPrompt({ prompt: "Review the workspace" })).toBe("Review the workspace")
  })
})
