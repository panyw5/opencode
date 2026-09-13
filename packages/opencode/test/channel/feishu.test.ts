import { describe, expect, it } from "bun:test"
import { isSessionNotFoundError } from "@/channel/feishu"

describe("isSessionNotFoundError", () => {
  it("recognizes the SDK NotFoundError returned for a stale session", () => {
    expect(
      isSessionNotFoundError({
        name: "NotFoundError",
        data: { message: "Session not found: ses_stale" },
      }),
    ).toBe(true)
  })

  it("recognizes the Effect session not-found tag", () => {
    expect(isSessionNotFoundError({ _tag: "SessionNotFoundError", sessionID: "ses_stale" })).toBe(true)
  })

  it("does not treat unrelated SDK errors as a missing session", () => {
    expect(isSessionNotFoundError({ name: "UnauthorizedError", data: { message: "Unauthorized" } })).toBe(false)
    expect(isSessionNotFoundError(undefined)).toBe(false)
  })
})
