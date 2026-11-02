import { describe, expect, test } from "bun:test"
import {
  markCurrentNotifications,
  shouldNotifySuccessfulTurn,
  shouldNotifyTurnComplete,
  type Notification,
} from "./notification-state"

describe("notification", () => {
  test("idle is not success: suppress failure, cancellation and incomplete-turn completion notices", () => {
    expect(shouldNotifySuccessfulTurn({ role: "assistant", finish: "stop" })).toBe(true)
    expect(shouldNotifySuccessfulTurn({ role: "assistant", finish: "stop", error: { name: "APIError" } })).toBe(false)
    expect(shouldNotifySuccessfulTurn({ role: "assistant", error: { name: "MessageAbortedError" } })).toBe(false)
    expect(shouldNotifySuccessfulTurn({ role: "assistant", finish: "tool-calls" })).toBe(false)
    expect(shouldNotifySuccessfulTurn(undefined)).toBe(false)
  })
  test("viewing the current session does not silently consume actionable issues", () => {
    const item: Notification = {
      type: "error",
      issueID: "issue-1",
      session: "session-1",
      directory: "/project",
      time: 1,
      viewed: false,
      error: { name: "UnknownError", data: { message: "Login required" } },
    }
    expect(markCurrentNotifications([item], "session-1", "/project")[0].viewed).toBe(false)
  })
  test("marks only matching session notifications in the active directory as viewed", () => {
    const list: Notification[] = [
      { type: "turn-complete", time: 1, viewed: false, session: "a", directory: "/x" },
      {
        type: "error",
        time: 2,
        viewed: false,
        session: "a",
        directory: "/y",
        error: { name: "UnknownError", data: { message: "boom" } },
      },
      { type: "turn-complete", time: 3, viewed: false, session: "b", directory: "/x" },
      { type: "turn-complete", time: 4, viewed: true, session: "a", directory: "/x" },
    ]

    const next = markCurrentNotifications(list, "a", "/x")

    expect(next).not.toBe(list)
    expect(next[0]?.viewed).toBe(true)
    expect(next[1]?.viewed).toBe(false)
    expect(next[2]?.viewed).toBe(false)
    expect(next[3]?.viewed).toBe(true)
  })

  test("returns the original list when nothing matches", () => {
    const list: Notification[] = [{ type: "turn-complete", time: 1, viewed: false, session: "a", directory: "/x" }]

    expect(markCurrentNotifications(list, "b", "/x")).toBe(list)
    expect(markCurrentNotifications(list, "a", "/y")).toBe(list)
  })

  test("skips turn-complete notifications for archived sessions", () => {
    expect(shouldNotifyTurnComplete({ time: { created: 1, updated: 2 } })).toBe(true)
    expect(shouldNotifyTurnComplete({ time: { created: 1, updated: 2, archived: 3 } })).toBe(false)
  })

  test("skips turn-complete notifications for child sessions", () => {
    expect(shouldNotifyTurnComplete({ parentID: "ses_parent", time: { created: 1, updated: 2 } })).toBe(false)
  })
})
