import { describe, expect, test } from "bun:test"
import type { SessionBarTab } from "@/context/layout"
import { createConfigReturnTarget, resolveConfigReturnHref, resolveConfigReturnTarget } from "./config-navigation"

const tabs: SessionBarTab[] = [{ directory: "/repo", id: "ses_original" }]

describe("config return navigation", () => {
  test("restores the exact originating session while its tab exists", () => {
    const target = createConfigReturnTarget({
      pathname: "/L3JlcG8=/session/ses_original",
      search: "?view=review",
      directory: "/repo",
      id: "ses_original",
      session: true,
    })

    expect(resolveConfigReturnHref(target, tabs, [])).toBe(
      "/L3JlcG8=/session/ses_original?view=review",
    )
  })

  test("rejects an originating session or draft after its tab closes", () => {
    const session = createConfigReturnTarget({
      pathname: "/L3JlcG8=/session/ses_original",
      directory: "/repo",
      id: "ses_original",
      session: true,
    })
    const draft = createConfigReturnTarget({
      pathname: "/L3JlcG8=/session",
      directory: "/repo",
      session: true,
    })

    expect(resolveConfigReturnHref(session, [], [])).toBeUndefined()
    expect(resolveConfigReturnHref(draft, [], [])).toBeUndefined()
    expect(resolveConfigReturnHref(draft, [], ["/repo"])).toBe("/L3JlcG8=/session")
  })

  test("preserves home and scheduled routes without requiring a session tab", () => {
    const home = createConfigReturnTarget({ pathname: "/", session: false })
    const scheduled = createConfigReturnTarget({ pathname: "/L3JlcG8=/scheduled", search: "?task=1", session: false })
    const globalScheduled = createConfigReturnTarget({ pathname: "/scheduled", session: false })

    expect(resolveConfigReturnHref(home, [], [])).toBe("/")
    expect(resolveConfigReturnHref(scheduled, [], [])).toBe("/L3JlcG8=/scheduled?task=1")
    expect(resolveConfigReturnHref(globalScheduled, [], [])).toBe("/scheduled")
  })

  test("does not preserve a blank project index as a return target", () => {
    expect(createConfigReturnTarget({ pathname: "/L3JlcG8=", directory: "/repo", session: false })).toBeUndefined()
    expect(resolveConfigReturnTarget({ type: "route", href: "/unexpected" }, [], [])).toBeUndefined()
    expect(resolveConfigReturnTarget({ type: "session", href: "/bad", id: "ses_original" }, tabs, [])).toBeUndefined()
  })
})
