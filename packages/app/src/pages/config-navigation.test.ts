import { describe, expect, test } from "bun:test"
import type { SessionBarTab } from "@/context/layout"
import {
  createConfigReturnTarget,
  resolveConfigReturnHref,
  resolveConfigReturnTarget,
  resolveBrowserSessionTarget,
} from "./config-navigation"

const tabs: SessionBarTab[] = [{ directory: "/repo", id: "ses_original" }]

describe("config return navigation", () => {
  test("browser restores the originating session, not another open tab", () => {
    expect(
      resolveBrowserSessionTarget({
        origin: { type: "session", directory: "/repo", id: "ses_original", href: "/repo/session/ses_original" },
        tabs: [...tabs, { directory: "/other", id: "ses_other" }],
        drafts: [],
      }),
    ).toMatchObject({ type: "session", id: "ses_original" })
  })

  test("browser replaces a home/scheduled origin with a session that can host the panel", () => {
    expect(resolveBrowserSessionTarget({ origin: { type: "route", href: "/" }, tabs, drafts: [] })).toMatchObject({
      type: "session",
      id: "ses_original",
    })
    expect(
      resolveBrowserSessionTarget({
        origin: { type: "route", href: "/scheduled" },
        tabs: [],
        drafts: [{ directory: "/repo", id: "draft-1" }],
      }),
    ).toMatchObject({ type: "draft", id: "draft-1" })
    expect(resolveBrowserSessionTarget({ tabs: [], drafts: [] })).toEqual({ type: "home" })
  })

  test("browser falls back when its original tab was closed", () => {
    expect(
      resolveBrowserSessionTarget({
        origin: { type: "session", directory: "/repo", id: "closed", href: "/repo/session/closed" },
        tabs,
        drafts: [],
      }),
    ).toMatchObject({ type: "session", id: "ses_original" })
  })
  test("restores the exact originating session while its tab exists", () => {
    const target = createConfigReturnTarget({
      pathname: "/L3JlcG8=/session/ses_original",
      search: "?view=review",
      directory: "/repo",
      id: "ses_original",
      session: true,
    })

    expect(resolveConfigReturnHref(target, tabs, [])).toBe("/L3JlcG8=/session/ses_original?view=review")
  })

  test("rejects an originating session or draft after its tab closes", () => {
    const session = createConfigReturnTarget({
      pathname: "/L3JlcG8=/session/ses_original",
      directory: "/repo",
      id: "ses_original",
      session: true,
    })
    const draft = createConfigReturnTarget({
      pathname: "/L3JlcG8=/session/new/draft-1",
      directory: "/repo",
      draftID: "draft-1",
      session: true,
    })

    expect(resolveConfigReturnHref(session, [], [])).toBeUndefined()
    expect(resolveConfigReturnHref(draft, [], [])).toBeUndefined()
    expect(resolveConfigReturnHref(draft, [], [{ id: "draft-1", directory: "/repo" }])).toBe(
      "/L3JlcG8=/session/new/draft-1",
    )
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
