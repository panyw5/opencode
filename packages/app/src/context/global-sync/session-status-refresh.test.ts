import { describe, expect, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createStore, reconcile } from "solid-js/store"
import {
  authoritativeSessionStatusMap,
  isSessionStatusRefreshBoundary,
  mergeSessionStatusRefresh,
  SESSION_STATUS_VISIBILITY_REFRESH_MS,
  shouldRefreshSessionStatusOnVisibility,
} from "./session-status-refresh"

describe("session-status-refresh", () => {
  test("visibility restore only after a long background", () => {
    expect(SESSION_STATUS_VISIBILITY_REFRESH_MS).toBeGreaterThanOrEqual(30_000)
    expect(shouldRefreshSessionStatusOnVisibility(0)).toBe(false)
    expect(shouldRefreshSessionStatusOnVisibility(SESSION_STATUS_VISIBILITY_REFRESH_MS - 1)).toBe(false)
    expect(shouldRefreshSessionStatusOnVisibility(SESSION_STATUS_VISIBILITY_REFRESH_MS)).toBe(true)
    expect(shouldRefreshSessionStatusOnVisibility(SESSION_STATUS_VISIBILITY_REFRESH_MS + 5_000)).toBe(true)
  })

  test("only boundary reasons activate full-table refresh", () => {
    expect(isSessionStatusRefreshBoundary("bootstrap")).toBe(true)
    expect(isSessionStatusRefreshBoundary("server-connected")).toBe(true)
    expect(isSessionStatusRefreshBoundary("global-disposed")).toBe(true)
    expect(isSessionStatusRefreshBoundary("visibility")).toBe(true)
    expect(isSessionStatusRefreshBoundary("manual")).toBe(true)
  })

  test("authoritative map replaces omitted idle entries", () => {
    const next = authoritativeSessionStatusMap({
      ses_live: { type: "busy" } as SessionStatus,
    })

    expect(next).toEqual({ ses_live: { type: "busy" } })
    expect(next.ses_stale).toBeUndefined()
  })

  test("nullish server payloads become an empty map", () => {
    expect(authoritativeSessionStatusMap(undefined)).toEqual({})
    expect(authoritativeSessionStatusMap(null)).toEqual({})
  })

  test("reconcile clears stale busy entries omitted by the server", () => {
    const [store, setStore] = createStore<{ session_status: Record<string, SessionStatus> }>({
      session_status: {
        ses_stale: { type: "busy" } as SessionStatus,
        ses_live: { type: "busy" } as SessionStatus,
      },
    })

    setStore(
      "session_status",
      reconcile(
        authoritativeSessionStatusMap({
          ses_live: { type: "retry", attempt: 1, message: "wait", next: 2 } as SessionStatus,
        }),
      ),
    )

    expect(store.session_status.ses_stale).toBeUndefined()
    expect(store.session_status.ses_live).toEqual({
      type: "retry",
      attempt: 1,
      message: "wait",
      next: 2,
    })
  })

  test("reconcile clears the whole map when server returns no active sessions", () => {
    const [store, setStore] = createStore<{ session_status: Record<string, SessionStatus> }>({
      session_status: {
        ses_stale: { type: "busy" } as SessionStatus,
      },
    })

    setStore("session_status", reconcile(authoritativeSessionStatusMap({})))

    expect(store.session_status).toEqual({})
  })

  test("merge keeps optimistic busy while the last message is still a user turn", () => {
    const user = { id: "msg_user", role: "user", sessionID: "ses_1" } as Message
    const next = mergeSessionStatusRefresh(
      { ses_1: { type: "busy" } as SessionStatus },
      {},
      { ses_1: [user] },
    )
    expect(next.ses_1).toEqual({ type: "busy" })
  })

  test("merge drops local busy when the turn has a completed assistant", () => {
    const user = { id: "msg_user", role: "user", sessionID: "ses_1" } as Message
    const assistant = {
      id: "msg_assistant",
      role: "assistant",
      sessionID: "ses_1",
      parentID: "msg_user",
      time: { created: 1, completed: 2 },
    } as Message
    const next = mergeSessionStatusRefresh(
      { ses_1: { type: "busy" } as SessionStatus },
      {},
      { ses_1: [user, assistant] },
    )
    expect(next.ses_1).toBeUndefined()
  })

  test("merge prefers the server status when present", () => {
    const user = { id: "msg_user", role: "user", sessionID: "ses_1" } as Message
    const next = mergeSessionStatusRefresh(
      { ses_1: { type: "busy" } as SessionStatus },
      { ses_1: { type: "retry", attempt: 1, message: "wait", next: 2 } as SessionStatus },
      { ses_1: [user] },
    )
    expect(next.ses_1).toEqual({
      type: "retry",
      attempt: 1,
      message: "wait",
      next: 2,
    })
  })
})
