import { describe, expect, test } from "bun:test"
import {
  readSessionReferenceClipboard,
  sessionReferenceClipboard,
  sessionReferencePart,
} from "./session-reference-clipboard"

const reference = {
  type: "session" as const,
  sessionID: "ses_source",
  directory: "/repo/other project",
  title: "引用 <A> & B",
  updatedAt: 1700000000000,
  summary: "user: question\n\nassistant: answer",
}

describe("session reference clipboard", () => {
  test("round-trips a portable snapshot including Unicode and special characters", () => {
    const text = sessionReferenceClipboard(reference)
    expect(text.startsWith("opencode://session-reference/v1#")).toBe(true)
    expect(readSessionReferenceClipboard(`  ${text}\n`)).toEqual(reference)
    expect(sessionReferencePart(reference)).toEqual({
      type: "session",
      reference,
      content: `@${reference.title}`,
      start: 0,
      end: reference.title.length + 1,
    })
  })

  test("leaves ordinary text, copied session info, unknown versions, and mixed text untouched", () => {
    for (const text of [
      "hello",
      "Session ID: ses_source\nProject path: /repo",
      "opencode://session-reference/v2#{}",
      `Continue ${sessionReferenceClipboard(reference)}`,
      JSON.stringify(reference),
    ]) {
      expect(readSessionReferenceClipboard(text)).toBeUndefined()
    }
  })

  test("rejects malformed, oversized and invalid references", () => {
    const prefix = "opencode://session-reference/v1#"
    for (const text of [
      prefix + "%",
      prefix + "not-json",
      prefix + encodeURIComponent("{}"),
      prefix + "a".repeat(128 * 1024),
      sessionReferenceClipboard({ ...reference, sessionID: "bad" }),
      sessionReferenceClipboard({ ...reference, updatedAt: Infinity }),
    ]) {
      expect(readSessionReferenceClipboard(text)).toBeUndefined()
    }
  })
})
