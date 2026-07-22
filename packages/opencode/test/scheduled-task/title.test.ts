import { describe, expect, test } from "bun:test"
import {
  isScheduledSessionTitle,
  markScheduledSessionTitle,
  SCHEDULED_SESSION_TITLE_PREFIX,
  stripScheduledSessionTitle,
} from "@/scheduled-task/title"

describe("scheduled session title", () => {
  test("marks plain titles with the scheduled prefix", () => {
    expect(markScheduledSessionTitle("Nightly review")).toBe(`${SCHEDULED_SESSION_TITLE_PREFIX} Nightly review`)
    expect(markScheduledSessionTitle("  spaced  ")).toBe(`${SCHEDULED_SESSION_TITLE_PREFIX} spaced`)
  })

  test("is idempotent", () => {
    const once = markScheduledSessionTitle("Nightly review")
    expect(markScheduledSessionTitle(once)).toBe(once)
    expect(isScheduledSessionTitle(once)).toBe(true)
  })

  test("strips prefix for display", () => {
    expect(stripScheduledSessionTitle(`${SCHEDULED_SESSION_TITLE_PREFIX} Nightly review`)).toBe("Nightly review")
    expect(stripScheduledSessionTitle("normal")).toBe("normal")
    expect(stripScheduledSessionTitle(SCHEDULED_SESSION_TITLE_PREFIX)).toBe(SCHEDULED_SESSION_TITLE_PREFIX)
  })
})
