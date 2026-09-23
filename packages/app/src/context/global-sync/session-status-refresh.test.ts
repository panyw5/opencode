import { describe, expect, test } from "bun:test"
import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createStore, reconcile } from "solid-js/store"
import {
  authoritativeSessionStatusMap,
  bumpSessionStatusRevision,
  isSessionStatusRefreshBoundary,
  mergeSessionStatusRefresh,
  pendingSessionStatusIDs,
  sessionStatusRevisionSnapshot,
  sessionStatusValueSnapshot,
  SESSION_STATUS_VISIBILITY_REFRESH_MS,
  sessionsToReconcileOnStreamConnect,
  sessionsToReconcileMessagesAfterStatusRefresh,
  sessionToReconcileOnStatusEvent,
  setSessionStatusPending,
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

  test("authoritative snapshot clears stale busy even when the cached turn ends with a user message", () => {
    const user = { id: "msg_user", role: "user", sessionID: "ses_1" } as Message
    const next = mergeSessionStatusRefresh({ ses_1: { type: "busy" } as SessionStatus }, {}, { ses_1: [user] })
    expect(next.ses_1).toBeUndefined()
  })

  test("pending submit lease preserves only its optimistic busy until request confirmation", () => {
    const directory = "/tmp/status-pending-test"
    setSessionStatusPending(directory, "ses_optimistic", true, "message_a")
    expect(pendingSessionStatusIDs(directory)).toEqual(["ses_optimistic"])
    expect(
      mergeSessionStatusRefresh(
        { ses_optimistic: { type: "busy" } as SessionStatus },
        {},
        {},
        pendingSessionStatusIDs(directory),
      ),
    ).toEqual({ ses_optimistic: { type: "busy" } })

    setSessionStatusPending(directory, "ses_optimistic", false, "message_a")
    expect(pendingSessionStatusIDs(directory)).toEqual([])
    expect(
      mergeSessionStatusRefresh(
        { ses_optimistic: { type: "busy" } as SessionStatus },
        {},
        {},
        pendingSessionStatusIDs(directory),
      ),
    ).toEqual({})
  })

  test("settling an older submit token does not clear a newer lease for the same session", () => {
    const directory = "/tmp/status-pending-concurrent-test"
    setSessionStatusPending(directory, "ses_rapid", true, "message_old")
    setSessionStatusPending(directory, "ses_rapid", true, "message_new")
    setSessionStatusPending(directory, "ses_rapid", false, "message_old")
    expect(pendingSessionStatusIDs(directory)).toEqual(["ses_rapid"])
    setSessionStatusPending(directory, "ses_rapid", false, "message_new")
    expect(pendingSessionStatusIDs(directory)).toEqual([])
  })

  test("a status event newer than an in-flight snapshot wins over that response", () => {
    const busy = { type: "busy" } as SessionStatus
    const idle = { type: "idle" } as SessionStatus
    expect(
      mergeSessionStatusRefresh({ ses_1: idle }, { ses_1: busy }, {}, [], sessionStatusValueSnapshot({ ses_1: busy })),
    ).toEqual({ ses_1: idle })
    expect(mergeSessionStatusRefresh({ ses_1: busy }, {}, {}, [], sessionStatusValueSnapshot({}))).toEqual({
      ses_1: busy,
    })
  })

  test("reconcile preserves an idle event newer than an in-flight busy snapshot", () => {
    const directory = "/tmp/status-revision-idle-test"
    const busy = { type: "busy" } as SessionStatus
    const idle = { type: "idle" } as SessionStatus
    const [store, setStore] = createStore<{ session_status: Record<string, SessionStatus> }>({
      session_status: { ses_1: busy },
    })
    const valuesAtStart = sessionStatusValueSnapshot(store.session_status)
    const revisionsAtStart = sessionStatusRevisionSnapshot(directory)
    bumpSessionStatusRevision(directory, "ses_1")
    setStore("session_status", "ses_1", reconcile(idle))

    const next = mergeSessionStatusRefresh(
      store.session_status,
      { ses_1: busy },
      {},
      [],
      valuesAtStart,
      revisionsAtStart,
      sessionStatusRevisionSnapshot(directory),
    )
    expect(next.ses_1).toEqual(idle)
  })

  test("revision preserves a same-value busy event from a newer worker generation", () => {
    const directory = "/tmp/status-revision-restart-test"
    const busy = { type: "busy" } as SessionStatus
    const [store, setStore] = createStore<{ session_status: Record<string, SessionStatus> }>({
      session_status: { ses_1: busy },
    })
    const valuesAtStart = sessionStatusValueSnapshot(store.session_status)
    const revisionsAtStart = sessionStatusRevisionSnapshot(directory)
    bumpSessionStatusRevision(directory, "ses_1")
    setStore("session_status", "ses_1", reconcile({ type: "busy" } as SessionStatus))

    const next = mergeSessionStatusRefresh(
      store.session_status,
      {},
      {},
      [],
      valuesAtStart,
      revisionsAtStart,
      sessionStatusRevisionSnapshot(directory),
    )
    expect(next.ses_1).toEqual(busy)
  })

  test("authoritative snapshot clears stale busy when messages were never loaded", () => {
    const next = mergeSessionStatusRefresh({ ses_1: { type: "busy" } as SessionStatus }, {}, {})
    expect(next.ses_1).toBeUndefined()
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

  test("stream reconnect selects every busy session for reconciliation, including unloaded messages", () => {
    expect(
      sessionsToReconcileOnStreamConnect(
        {
          ses_loaded: { type: "busy" },
          ses_unloaded: { type: "busy" },
          ses_idle: { type: "idle" },
        } as Record<string, SessionStatus>,
        {
          ses_loaded: [],
          ses_idle: [{ id: "msg_idle" } as Message],
        },
      ),
    ).toEqual(["ses_loaded", "ses_unloaded"])
  })

  test("status refresh schedules message reconciliation when idle would expose a stale active assistant", () => {
    const activeAssistant = {
      id: "msg_assistant",
      role: "assistant",
      sessionID: "ses_stale_transcript",
      time: { created: 1 },
    } as Message
    expect(
      sessionsToReconcileMessagesAfterStatusRefresh(
        { ses_stale_transcript: { type: "busy" } as SessionStatus },
        {},
        { ses_stale_transcript: [activeAssistant] },
      ),
    ).toEqual(["ses_stale_transcript"])
    expect(
      sessionsToReconcileMessagesAfterStatusRefresh(
        { ses_live: { type: "busy" } as SessionStatus },
        { ses_live: { type: "busy" } as SessionStatus },
        { ses_live: [activeAssistant] },
      ),
    ).toEqual([])
  })

  test("select transcript reconciliation before Solid reconcile mutates nested status proxies", () => {
    const activeAssistant = {
      id: "msg_active",
      role: "assistant",
      sessionID: "ses_proxy",
      time: { created: 1 },
    } as Message
    const [store, setStore] = createStore<{ session_status: Record<string, SessionStatus> }>({
      session_status: { ses_proxy: { type: "busy" } as SessionStatus },
    })
    const previous = { ...store.session_status }
    const next = { ses_proxy: { type: "idle" } as SessionStatus }
    const transcripts = sessionsToReconcileMessagesAfterStatusRefresh(previous, next, {
      ses_proxy: [activeAssistant],
    })
    setStore("session_status", reconcile(next))

    expect(transcripts).toEqual(["ses_proxy"])
  })

  test("idle status event selects a session only when it was locally busy", () => {
    const statuses = {
      ses_busy: { type: "busy" },
      ses_idle: { type: "idle" },
    } as Record<string, SessionStatus>

    expect(
      sessionToReconcileOnStatusEvent(
        { type: "session.status", properties: { sessionID: "ses_busy", status: { type: "idle" } } },
        statuses,
      ),
    ).toBe("ses_busy")
    expect(
      sessionToReconcileOnStatusEvent(
        { type: "session.status", properties: { sessionID: "ses_idle", status: { type: "idle" } } },
        statuses,
      ),
    ).toBeUndefined()
    expect(
      sessionToReconcileOnStatusEvent(
        { type: "session.status", properties: { sessionID: "ses_busy", status: { type: "retry" } } },
        statuses,
      ),
    ).toBeUndefined()
  })
})
