import { describe, expect, test } from "bun:test"
import { getSessionHandoff, setSessionHandoff, takeSessionContextHandoff } from "./handoff"

const reference = {
  type: "session" as const,
  sessionID: "ses_source",
  directory: "/source/project",
  title: "Source session",
  updatedAt: 1700000000000,
  summary: "user: Continue this work",
}

describe("session reference handoff", () => {
  test("only attaches to the intended draft and is consumed once", () => {
    setSessionHandoff("project/draft_reference", { context: [reference] })
    expect(takeSessionContextHandoff("project/ses_current")).toEqual([])
    expect(takeSessionContextHandoff("project/draft_other")).toEqual([])
    expect(takeSessionContextHandoff("project/draft_reference")).toEqual([reference])
    expect(takeSessionContextHandoff("project/draft_reference")).toEqual([])
  })

  test("preserves references across prompt updates and leaves other handoff data intact", () => {
    const key = "project/draft_preview"
    setSessionHandoff(key, { context: [reference], files: { "src/main.ts": null } })
    setSessionHandoff(key, { prompt: "New draft text" })
    expect(takeSessionContextHandoff(key)).toEqual([reference])
    expect(getSessionHandoff(key)).toEqual({ prompt: "New draft text", files: { "src/main.ts": null } })
  })

  test("separate drafts can reference the same session independently", () => {
    setSessionHandoff("project/draft_one", { context: [reference] })
    setSessionHandoff("project/draft_two", { context: [reference] })
    expect(takeSessionContextHandoff("project/draft_one")).toEqual([reference])
    expect(takeSessionContextHandoff("project/draft_two")).toEqual([reference])
  })
})
