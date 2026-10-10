import { describe, expect, test } from "bun:test"
import { gptProCanResume, gptProDiagnostic, gptProIssue } from "./gpt-pro-error"

describe("GPT-Pro issue classification", () => {
  test.each([
    [
      "Error invoking remote method 'gpt-pro-command': Error: owner_page_busy: consultation gpt_a is still paused",
      "owner_busy",
    ],
    ["Pause or stop the active consultation before opening another conversation", "owner_busy"],
    ["Browser verification required", "verification"],
    ["Sign in to ChatGPT before continuing this consultation", "login"],
    ["Stop active gpt-pro consultations before opening a new login connection.", "login_import_busy"],
    ["Stop the active consultation before replacing its login session.", "login_import_busy"],
    ["browser_open_failed: Could not open the default browser", "browser_open_failed"],
    ["login_connection_failed: The local connection page could not be started", "login_connection_failed"],
    ["Enable gpt-pro in Settings > External Agents first.", "disabled"],
    ["page_capacity: all resident consultation pages are protected", "page_capacity"],
    ["Too many queued consultations", "queue_capacity"],
    ["ChatGPT rejected request (HTTP 403)", "request_rejected"],
    ["HTTP 429: too many requests", "rate_limit"],
    ["Consultation timed out. The original page is preserved", "timeout"],
    ["The browser client is not connected", "connection"],
    ["Failed to fetch", "connection"],
    ["The consultation page closed", "page_closed"],
    ["The submitted user turn does not match the managed prompt; no reply was accepted.", "page_changed"],
    ["A manual draft or attachment is present", "draft_protected"],
    ["The browser is busy or has a manual draft", "draft_protected"],
    ["Each attachment must be at most 20 MiB", "attachment"],
    ["Consultation not found in this OpenCode session", "history_missing"],
    ["Reply exceeds HTML capture limit", "response_too_large"],
    ["ChatGPT composer did not become available", "control_unavailable"],
    ["owner_session_cancelled: consultation creation was revoked", "cancelled"],
    ["Application stopped. Resume explicitly", "interrupted"],
    ["Website stop could not be confirmed. Check the original webpage", "stop_unconfirmed"],
    ["A completely new diagnostic", "unknown"],
  ] as const)("classifies %s as %s", (error, code) => {
    expect(gptProIssue({ error })?.code).toBe(code)
  })

  test("send uncertainty wins over HTTP or explicit cause codes", () => {
    expect(gptProIssue({ phase: "send_uncertain", error: "HTTP 401", code: "login" })?.code).toBe("send_uncertain")
    expect(gptProIssue({ error: "Submission was attempted but not confirmed: network error" })?.code).toBe(
      "send_uncertain",
    )
    expect(gptProIssue({ error: new Error("Submission is uncertain. Inspect the original page") })?.code).toBe(
      "send_uncertain",
    )
  })
  test("queue and pause are informational, normal completion or stop is not an error", () => {
    for (const queueReason of ["capacity", "page_capacity", "owner_busy"])
      expect(gptProIssue({ phase: "queued", queueReason })?.tone).toBe("info")
    expect(gptProIssue({ phase: "paused" })?.tone).toBe("info")
    expect(gptProIssue({ phase: "cancelled" })).toBeUndefined()
    expect(gptProIssue({ phase: "completed" })).toBeUndefined()
    expect(gptProIssue({ code: "invented" })).toBeUndefined()
  })
  test("resume is never offered for uncertain or attempted-but-unconfirmed sends", () => {
    expect(gptProCanResume({ phase: "send_uncertain" })).toBe(false)
    expect(gptProCanResume({ phase: "paused", error: "A send was already attempted" })).toBe(false)
    expect(gptProCanResume({ phase: "paused", sendAttempted: true })).toBe(false)
    expect(gptProCanResume({ phase: "paused", submitted: true })).toBe(false)
    expect(gptProCanResume({ phase: "paused", sendAttempted: true, userID: "user" })).toBe(true)
    expect(gptProCanResume({ phase: "paused" })).toBe(true)
    expect(gptProCanResume({ phase: "interrupted", submitted: true, userID: "user" })).toBe(true)
    expect(gptProCanResume({ phase: "interrupted" })).toBe(false)
    expect(gptProCanResume({ phase: "cancelled" })).toBe(false)
  })
  test("diagnostics unwrap IPC errors, redact credentials and bound unknown inputs", () => {
    expect(gptProDiagnostic("Error: Error invoking remote method 'gpt-pro-command': Error: owner_page_busy")).toBe(
      "owner_page_busy",
    )
    expect(gptProDiagnostic("network error\n    at private/file.ts:1")).toBe("network error")
    const diagnostic = gptProDiagnostic(
      "Cookie: session=secret; other=secret-two\nAuthorization: Bearer abc\napi_key=key\npassword=pw",
    )
    for (const secret of ["secret", "secret-two", "abc", "key\n", "pw"]) expect(diagnostic).not.toContain(secret)
    expect(gptProDiagnostic({ message: "failed", credentials: "private" })).toBe("failed")
    expect(gptProDiagnostic({ token: "private" })).toBe("")
    expect(gptProDiagnostic("a".repeat(5000))).toHaveLength(2000)
  })
})
