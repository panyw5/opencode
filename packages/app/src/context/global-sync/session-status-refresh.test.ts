import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createStore, reconcile } from "solid-js/store"
import {
  authoritativeSessionStatusMap,
  PROJECT_SESSION_STATUS_REFRESH_INTERVAL,
  shouldRefreshProjectSessionStatus,
} from "./session-status-refresh"

describe("session-status-refresh", () => {
  test("uses a bounded refresh interval while active", () => {
    expect(PROJECT_SESSION_STATUS_REFRESH_INTERVAL).toBeGreaterThanOrEqual(5_000)
    expect(PROJECT_SESSION_STATUS_REFRESH_INTERVAL).toBeLessThanOrEqual(30_000)
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

  test("refresh only while the project appears active", () => {
    expect(shouldRefreshProjectSessionStatus(true)).toBe(true)
    expect(shouldRefreshProjectSessionStatus(false)).toBe(false)
  })

  test("reconcile clears stale busy entries omitted by the server", () => {
    const [store, setStore] = createStore({
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
    const [store, setStore] = createStore({
      session_status: {
        ses_stale: { type: "busy" } as SessionStatus,
      },
    })

    setStore("session_status", reconcile(authoritativeSessionStatusMap({})))

    expect(store.session_status).toEqual({})
  })
})
