import { describe, expect, test } from "bun:test"
import {
  activeAfterClose,
  assistantWindowTitle,
  initialAssistantWindows,
  migrateAssistantWindows,
  newAssistantWindow,
  openAssistantSession,
} from "./windows"

describe("quick assistant windows", () => {
  test("initial and newly added conversations enable main-session context by default", () => {
    expect(initialAssistantWindows().windows).toEqual([{ id: "legacy", number: 1, context: true }])
    expect(newAssistantWindow("new", 2)).toEqual({ id: "new", number: 2, context: true })
  })

  test("migration preserves an explicitly disabled context preference", () => {
    expect(
      migrateAssistantWindows({ context: false, session: { __quick__: "ses_existing" } }).windows[0],
    ).toMatchObject({
      session: "ses_existing",
      context: false,
    })
    expect(migrateAssistantWindows({}).windows[0].context).toBe(true)
  })

  test("migrates the existing conversation and preferences without losing its session", () => {
    const migrated = migrateAssistantWindows({
      open: true,
      maximized: true,
      session: { __quick__: "ses_existing", old_project: "ses_unused" },
      context: true,
      variant: "high",
    })
    expect(migrated).toEqual({
      open: true,
      maximized: true,
      windows: [{ id: "legacy", number: 1, session: "ses_existing", context: true, variant: "high" }],
      active: "legacy",
      next: 2,
    })
  })

  test("round trips independent conversations and repairs a missing active window", () => {
    const saved = {
      ...initialAssistantWindows(),
      windows: [
        { id: "a", number: 1, session: "ses_a", context: true, variant: "high" },
        { id: "b", number: 3, session: "ses_b", context: false },
      ],
      active: "missing",
      next: 2,
    }
    expect(migrateAssistantWindows(saved)).toEqual({ ...saved, active: "a", next: 4 })
  })

  test("closing the last window stays empty after a restart", () => {
    expect(migrateAssistantWindows({ open: true, windows: [], active: "removed", next: 5 })).toEqual({
      open: false,
      maximized: false,
      windows: [],
      active: undefined,
      next: 5,
    })
  })

  test("ignores duplicate or malformed windows", () => {
    expect(
      migrateAssistantWindows({
        windows: [
          { id: "a", number: 1, context: false },
          { id: "a", number: 2, context: false },
          null,
          { id: "invalid", number: -1 },
        ],
      }).windows,
    ).toEqual([{ id: "a", number: 1, context: false }])
    expect(migrateAssistantWindows(null)).toEqual(initialAssistantWindows())
  })

  const windows = ["a", "b", "c"].map((id, i) => ({ id, number: i + 1, context: false }))
  test("closing the active window selects its next neighbor then its previous neighbor", () => {
    expect(activeAfterClose(windows, "b", "b")).toBe("c")
    expect(activeAfterClose(windows, "c", "c")).toBe("b")
    expect(activeAfterClose(windows.slice(0, 1), "a", "a")).toBeUndefined()
  })

  test("closing a background window preserves the active conversation", () => {
    expect(activeAfterClose(windows, "b", "a")).toBe("b")
    expect(activeAfterClose(windows, "a", "c")).toBe("a")
  })

  test("a notification reopens and selects the matching window without losing drafts or preferences", () => {
    const saved = {
      ...initialAssistantWindows(),
      maximized: true,
      windows: [
        { id: "a", number: 1, session: "ses_a", context: true, variant: "high", title: "First" },
        { id: "b", number: 2, session: "ses_b", context: false },
      ],
      active: "b",
      next: 3,
    }
    const next = openAssistantSession(saved, "ses_a", "unused")
    expect(next).toEqual({ ...saved, open: true, active: "a" })
    expect(next.windows).toBe(saved.windows)
  })

  test("a notification restores a closed session in a new window and reuses it on repeated clicks", () => {
    const saved = initialAssistantWindows()
    const next = openAssistantSession(saved, "ses_closed", "restored")
    expect(next.windows).toEqual([
      ...saved.windows,
      { id: "restored", number: 2, session: "ses_closed", context: false },
    ])
    expect(next.active).toBe("restored")
    expect(next.open).toBe(true)
    expect(next.next).toBe(3)
    expect(openAssistantSession(next, "ses_closed", "duplicate")).toEqual(next)
    expect(saved.windows).toHaveLength(1)
  })

  test("uses generated titles and falls back to the first question for placeholder titles", () => {
    expect(assistantWindowTitle("  Generated title  ", "First question")).toBe("Generated title")
    expect(assistantWindowTitle("Quick Assistant", "  First\nquestion  ")).toBe("First question")
    expect(assistantWindowTitle("New session - 2026-10-27T00:00:00.000Z", "Question")).toBe("Question")
    expect(assistantWindowTitle(undefined, "")).toBeUndefined()
    expect(assistantWindowTitle("My New session - notes", "Question")).toBe("My New session - notes")
    expect(assistantWindowTitle(undefined, "x".repeat(200))).toHaveLength(100)
  })

  test("persists generated window titles independently", () => {
    const state = initialAssistantWindows()
    state.windows = [
      { id: "a", number: 1, context: false, title: "First topic" },
      { id: "b", number: 2, context: false, title: "Second topic" },
    ]
    expect(migrateAssistantWindows(state).windows.map((item) => item.title)).toEqual(["First topic", "Second topic"])
  })
})
