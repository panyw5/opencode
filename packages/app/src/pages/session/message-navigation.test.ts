import { describe, expect, test } from "bun:test"
import { createMessageNavigation } from "./message-navigation"

const snapshot = { ready: true, loaded: true, more: false, busy: false }
const message = (id: string) => ({ kind: "message" as const, id, behavior: "auto" as const })
const controller = () => {
  const value = createMessageNavigation()
  value.reset("session-a", "#message-last")
  return value
}

describe("message navigation", () => {
  test("loaded and unloaded requests share the same target and seek transition", () => {
    for (const initiallyLoaded of [false, true]) {
      const value = controller()
      const token = value.request(message("first"), "#message-first")
      const action = value.reconcile({ ...snapshot, loaded: initiallyLoaded, more: true })
      expect(action?.kind).toBe(initiallyLoaded ? "seek" : "load")
      if (!initiallyLoaded) {
        value.finishLoad(token)
        expect(value.reconcile(snapshot)).toEqual({ kind: "seek", token, target: message("first") })
      }
      expect(value.state().target).toEqual(message("first"))
    }
  })

  test("old hash updates cannot replace a loaded target before router acknowledgement", () => {
    const value = controller()
    value.request(message("first"), "#message-first")
    expect(value.observeHash("#message-last")).toBe("superseded")
    value.reconcile(snapshot)
    expect(value.observeHash("#message-last")).toBe("superseded")
    expect(value.state().target).toEqual(message("first"))
    expect(value.observeHash("#message-first")).toBe("acknowledged")
    expect(value.observeHash("#message-last")).toBe("superseded")
    expect(value.observeHash("#message-first")).toBe("acknowledged")
    value.finishSeek({ sessionKey: "session-a", generation: value.state().generation }, true)
    expect(value.observeHash("#message-other")).toBe("external")
  })

  test("loads multiple pages and waits for readiness and busy history without duplicate fetches", () => {
    const value = controller()
    const token = value.request(message("first"), "#message-first")
    expect(value.reconcile({ ...snapshot, ready: false })).toBeUndefined()
    expect(value.reconcile({ ...snapshot, loaded: false, more: true, busy: true })).toBeUndefined()
    const missing = { ...snapshot, loaded: false, more: true }
    expect(value.reconcile(missing)?.kind).toBe("load")
    expect(value.reconcile(missing)).toBeUndefined()
    value.finishLoad(token)
    expect(value.reconcile(missing)?.kind).toBe("load")
    value.finishLoad(token)
    expect(value.reconcile(snapshot)?.kind).toBe("seek")
    expect(value.reconcile(snapshot)).toBeUndefined()
  })

  test("switching to a loaded message during an old fetch starts the new seek immediately", () => {
    const value = controller()
    const old = value.request(message("first"), "#message-first")
    value.reconcile({ ...snapshot, loaded: false, more: true })
    const next = value.request(message("last"), "#message-last")
    expect(value.current(old)).toBe(false)
    expect(value.reconcile({ ...snapshot, busy: true })).toEqual({ kind: "seek", token: next, target: message("last") })
    expect(value.finishSeek(next, true)).toBe(false)
    expect(value.state().historyPending).toBe(true)
    expect(value.finishLoad(old, true)).toBe(true)
    expect(value.state().phase).toBe("seeking")
    expect(value.finishSeek(old, true)).toBe(false)
    expect(value.finishSeek(next, true)).toBe(true)
  })

  test("a second unloaded click waits for the shared fetch then continues only for its own target", () => {
    const value = controller()
    const old = value.request(message("first"), "#message-first")
    const missing = { ...snapshot, loaded: false, more: true }
    value.reconcile(missing)
    const next = value.request(message("second"), "#message-second")
    expect(value.reconcile(missing)).toBeUndefined()
    expect(value.finishLoad(old)).toBe(true)
    expect(value.reconcile(missing)).toEqual({ kind: "load", token: next })
    expect(value.observeHash("#message-first")).toBe("superseded")
  })

  test("a rapid return to the currently observed hash rejects the intervening delayed router write", () => {
    const value = controller()
    value.request(message("first"), "#message-first")
    value.request(message("last"), "#message-last")
    expect(value.observeHash("#message-first")).toBe("superseded")
    expect(value.state().target).toEqual(message("last"))
    expect(value.observeHash("#message-last")).toBe("acknowledged")
  })

  test("a new external anchor is not mistaken for an obsolete router write during navigation", () => {
    const value = controller()
    value.request(message("first"), "#message-first")
    expect(value.observeHash("#review-new")).toBe("external")
    const token = value.request({ kind: "anchor", id: "review-new", behavior: "auto" })
    expect(value.reconcile(snapshot)).toEqual({
      kind: "seek",
      token,
      target: { kind: "anchor", id: "review-new", behavior: "auto" },
    })
  })

  test("clearing during an asynchronous hash write prevents the old route from reviving navigation", () => {
    const value = controller()
    value.reset("session-a", "")
    value.request(message("first"), "#message-first")
    value.request(undefined, "")
    expect(value.observeHash("#message-first")).toBe("superseded")
    expect(value.state().target).toBeUndefined()
    expect(value.observeHash("")).toBe("acknowledged")
  })

  test("clear, session switch, and a later click invalidate every old seek token", () => {
    for (const transition of ["clear", "session", "click"] as const) {
      const value = controller()
      const old = value.request(message("first"), "#message-first")
      value.reconcile(snapshot)
      if (transition === "clear") value.request(undefined, "")
      if (transition === "session") value.reset("session-b", "")
      if (transition === "click") value.request(message("last"), "#message-last")
      expect(value.current(old)).toBe(false)
      expect(value.finishSeek(old, true)).toBe(false)
    }
  })

  test("an old session fetch cannot complete or fail navigation in the new session", () => {
    const value = controller()
    const old = value.request(message("first"))
    value.reconcile({ ...snapshot, loaded: false, more: true })
    value.reset("session-b", "")
    value.request(message("new"))
    expect(value.finishLoad(old, true)).toBe(false)
    expect(value.state().phase).toBe("waiting")
  })

  test("missing targets and fetch failures terminate without repeated requests", () => {
    for (const failure of ["missing", "fetch"] as const) {
      const value = controller()
      const token = value.request(message("first"))
      if (failure === "missing") expect(value.reconcile({ ...snapshot, loaded: false })?.kind).toBe("unavailable")
      else {
        value.reconcile({ ...snapshot, loaded: false, more: true })
        value.finishLoad(token, true)
      }
      expect(value.reconcile({ ...snapshot, loaded: false, more: true })).toBeUndefined()
      expect(value.state().phase).toBe(failure === "missing" ? "unavailable" : "failed")
      value.request(message("first"))
      expect(value.reconcile(snapshot)?.kind).toBe("seek")
    }
  })

  test("settled navigation does not restart on data changes or current-message updates", () => {
    const value = controller()
    const token = value.request(message("first"))
    value.reconcile(snapshot)
    value.finishSeek(token, true)
    expect(value.reconcile({ ...snapshot, loaded: false, more: true })).toBeUndefined()
    expect(value.state().phase).toBe("settled")
    expect(value.state().positionTarget).toBe("first")
    value.request(undefined, "")
    expect(value.state().positionTarget).toBeUndefined()
  })

  test("live and non-message anchors use the same readiness and completion lifecycle", () => {
    for (const target of [{ kind: "live" } as const, { kind: "anchor", id: "review", behavior: "auto" } as const]) {
      const value = controller()
      const token = value.request(target)
      expect(value.reconcile({ ...snapshot, ready: false })).toBeUndefined()
      expect(value.reconcile(snapshot)).toEqual({ kind: "seek", token, target })
      value.finishSeek(token, true)
      expect(value.state().phase).toBe("settled")
    }
  })

  test("find targets expose stable viewport identity without becoming page-load targets", () => {
    const value = controller()
    const target = {
      kind: "find" as const,
      rowKey: "row-2",
      messageID: "message-2",
      partID: "part-3",
      occurrence: 1,
      query: "needle",
      queryVersion: 4,
    }
    const token = value.requestFind(target)
    expect(value.reconcile({ ...snapshot, loaded: false, more: true })).toEqual({ kind: "seek", token, target })
    expect(value.state().viewportTarget).toEqual(target)
    expect(value.state().positionTarget).toBeUndefined()
    expect(value.finishSeek(token, true)).toBe(true)
    expect(value.state().viewportTarget).toEqual(target)
  })

  test("reading takeover settles without loading and releases an old shared fetch", () => {
    const value = controller()
    const old = value.request(message("old"))
    value.reconcile({ ...snapshot, loaded: false, more: true })
    const reading = value.requestReading()
    expect(value.current(old)).toBe(false)
    expect(value.reconcile({ ...snapshot, loaded: false, more: true })).toBeUndefined()
    expect(value.state().phase).toBe("settled")
    expect(value.state().viewportTarget).toBeUndefined()
    expect(value.state().historyPending).toBe(true)
    expect(value.finishLoad(old)).toBe(true)
    expect(value.state().historyPending).toBe(false)
    expect(value.finishSeek(old, true)).toBe(false)
    expect(value.finishSeek(reading, true)).toBe(true)
  })

  test("find no-match and close transitions cannot revive an old intent", () => {
    const value = controller()
    const find = value.requestFind({
      kind: "find",
      rowKey: "row-1",
      messageID: "message-1",
      partID: "part-1",
      occurrence: 0,
      query: "missing",
      queryVersion: 1,
    })
    expect(value.reconcile(snapshot)).toEqual({ kind: "seek", token: find, target: value.state().target! })
    expect(value.finishSeek(find, false)).toBe(true)
    expect(value.state().phase).toBe("unavailable")
    const reading = value.cancel()
    expect(value.current(find)).toBe(false)
    expect(value.reconcile(snapshot)).toBeUndefined()
    expect(value.state().target).toBeUndefined()
    expect(value.state().viewportTarget).toBeUndefined()
    expect(value.finishSeek(find, true)).toBe(false)
    expect(value.current(reading)).toBe(true)
  })

  test("session switching invalidates find and reading tokens", () => {
    const value = controller()
    const old = value.requestFind({
      kind: "find",
      rowKey: "row-1",
      messageID: "message-1",
      partID: "part-1",
      occurrence: 0,
      query: "needle",
      queryVersion: 1,
    })
    value.reset("session-b", "")
    const next = value.requestReading()
    expect(value.current(old)).toBe(false)
    expect(value.finishSeek(old, true)).toBe(false)
    expect(value.current(next)).toBe(true)
    expect(value.reconcile(snapshot)).toBeUndefined()
  })

  test("reading and find takeover reject delayed hashes from the prior intent", () => {
    const value = controller()
    value.requestFind(
      {
        kind: "find",
        rowKey: "row-1",
        messageID: "message-1",
        partID: "part-1",
        occurrence: 0,
        query: "needle",
        queryVersion: 1,
      },
      "",
    )
    expect(value.observeHash("#message-last")).toBe("superseded")
    value.request({ kind: "reading" }, "")
    expect(value.observeHash("#message-last")).toBe("superseded")
    expect(value.state().target).toEqual({ kind: "reading" })
    expect(value.observeHash("")).toBe("acknowledged")
  })
})
