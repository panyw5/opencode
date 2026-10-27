import { describe, expect, test } from "bun:test"
import { activeAfterClose, assistantWindowTitle, initialAssistantWindows, migrateAssistantWindows } from "./windows"

describe("quick assistant windows", () => {
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
