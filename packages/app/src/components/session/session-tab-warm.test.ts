import { describe, expect, test } from "bun:test"
import { pickWarmDirectories, shouldFetchTabMeta } from "./session-tab-warm"

describe("pickWarmDirectories", () => {
  const tabs = [
    { directory: "/Users/alice/active" },
    { directory: "/Users/alice/active" },
    { directory: "/Users/alice/background-a" },
    { directory: "/Users/alice/background-b" },
  ]

  test("warms only directories matching the active workspace", () => {
    expect(pickWarmDirectories(tabs, "/Users/alice/active")).toEqual(["/Users/alice/active"])
  })

  test("warms nothing when no active directory is set", () => {
    expect(pickWarmDirectories(tabs, "")).toEqual([])
  })

  test("normalizes trailing slashes when matching the active workspace", () => {
    expect(pickWarmDirectories([{ directory: "/Users/alice/active/" }], "/Users/alice/active")).toEqual([
      "/Users/alice/active/",
    ])
  })

  test("returns empty when every tab lives in another workspace", () => {
    expect(pickWarmDirectories([{ directory: "/Users/alice/other" }], "/Users/alice/active")).toEqual([])
  })
})

describe("shouldFetchTabMeta", () => {
  test("cold tab with persisted title stays request-free", () => {
    expect(shouldFetchTabMeta({ title: "kept title", sessionsReady: false, sessionInList: false })).toBe(false)
  })

  test("cold tab without stored title falls back to a per-session fetch", () => {
    expect(shouldFetchTabMeta({ sessionsReady: false, sessionInList: false })).toBe(true)
  })

  test("loaded directory with the session present refreshes from the list", () => {
    expect(shouldFetchTabMeta({ title: "stale", sessionsReady: true, sessionInList: true })).toBe(false)
  })

  test("loaded directory missing the session triggers a fetch", () => {
    expect(shouldFetchTabMeta({ title: "kept", sessionsReady: true, sessionInList: false })).toBe(true)
  })
})
