import { describe, expect, test } from "bun:test"
import {
  initialSessionRenderState,
  reduceSessionRenderState,
  sessionContentVisible,
  type SessionRenderState,
} from "./session-render-state"

const sessionID = "ses_test"

function transition(state: SessionRenderState, ...events: Parameters<typeof reduceSessionRenderState>[1][]) {
  return events.reduce(reduceSessionRenderState, state)
}

describe("session render state", () => {
  test("prefetched data can mount but must remain covered until its first layout settles", () => {
    const state = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      cached: true,
    })
    expect(state.phase).toBe("cached-visible")
    expect(state.overlay).toBe("showing")
    expect(sessionContentVisible(state)).toBe(true)

    const rendering = transition(state, { type: "messages-ready", sessionID }, { type: "content-ready", sessionID })
    expect(rendering.overlay).toBe("showing")
    const settled = reduceSessionRenderState(rendering, { type: "settled", sessionID })
    expect(settled.overlay).toBe("hiding")
    expect(reduceSessionRenderState(settled, { type: "overlay-hidden", sessionID }).overlay).toBe("hidden")
  })

  test("keeps cold content covered until rendered layout and scrolling settle", () => {
    const fetching = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      cached: false,
    })
    expect(fetching.phase).toBe("fetching")
    expect(fetching.overlay).toBe("showing")
    expect(sessionContentVisible(fetching)).toBe(false)

    const visible = reduceSessionRenderState(fetching, { type: "messages-ready", sessionID })
    expect(visible.phase).toBe("content-visible")
    expect(visible.overlay).toBe("showing")
    expect(sessionContentVisible(visible)).toBe(true)

    const rendering = reduceSessionRenderState(visible, { type: "content-ready", sessionID })
    expect(rendering.overlay).toBe("showing")
    const settled = reduceSessionRenderState(rendering, { type: "settled", sessionID })
    expect(settled.phase).toBe("interactive")
    expect(settled.overlay).toBe("hiding")
    expect(reduceSessionRenderState(settled, { type: "overlay-hidden", sessionID }).overlay).toBe("hidden")
  })

  test("only an optimistic new-session handoff skips the initial layout overlay", () => {
    const optimistic = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      cached: false,
      optimistic: true,
    })
    expect(optimistic.hasContent).toBe(true)
    expect(optimistic.overlay).toBe("hidden")
    expect(reduceSessionRenderState(optimistic, { type: "content-ready", sessionID }).overlay).toBe("hidden")
  })

  test("keeps cached content mounted under the overlay while reconciling and settling", () => {
    const cached = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      cached: true,
    })
    const state = transition(
      cached,
      { type: "reconcile", sessionID },
      { type: "settle", sessionID },
      { type: "settled", sessionID },
      { type: "overlay-hidden", sessionID },
    )
    expect(state.phase).toBe("interactive")
    expect(state.overlay).toBe("hidden")
    expect(sessionContentVisible(state)).toBe(true)
  })

  test("returning from an interactive session does not confuse cached data with a mounted viewport", () => {
    const previous = transition(
      initialSessionRenderState,
      { type: "session-change", sessionID: "ses_other", cached: true },
      { type: "settled", sessionID: "ses_other" },
      { type: "overlay-hidden", sessionID: "ses_other" },
    )
    const firstSwitch = reduceSessionRenderState(previous, { type: "session-change", sessionID, cached: true })
    expect(firstSwitch.hasContent).toBe(true)
    expect(firstSwitch.overlay).toBe("showing")
    expect(reduceSessionRenderState(firstSwitch, { type: "settled", sessionID: "ses_other" })).toBe(firstSwitch)
  })

  test("ignores callbacks from an older session generation", () => {
    const first = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      cached: false,
    })
    const second = reduceSessionRenderState(first, {
      type: "session-change",
      sessionID: "ses_next",
      cached: true,
    })
    expect(reduceSessionRenderState(second, { type: "messages-ready", sessionID })).toBe(second)
  })

  test("uses a wall-clock deadline only after content exists", () => {
    const fetching = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      cached: false,
    })
    expect(reduceSessionRenderState(fetching, { type: "deadline", sessionID })).toBe(fetching)

    const ready = reduceSessionRenderState(fetching, { type: "messages-ready", sessionID })
    const visible = reduceSessionRenderState(ready, { type: "deadline", sessionID })
    expect(visible.overlay).toBe("hidden")
    expect(sessionContentVisible(visible)).toBe(true)

    const interactive = reduceSessionRenderState(visible, { type: "settled", sessionID })
    expect(reduceSessionRenderState(interactive, { type: "deadline", sessionID })).toBe(interactive)
    expect(reduceSessionRenderState(visible, { type: "deadline", sessionID })).toBe(visible)
  })

  test("a deadline reveals available content even while the phase is fetching", () => {
    const fetching: SessionRenderState = {
      sessionID,
      generation: 1,
      phase: "fetching",
      overlay: "showing",
      hasContent: true,
    }
    const visible = reduceSessionRenderState(fetching, { type: "deadline", sessionID })
    expect(visible.phase).toBe("content-visible")
    expect(visible.overlay).toBe("hidden")
    expect(sessionContentVisible(visible)).toBe(true)
    expect(reduceSessionRenderState(visible, { type: "deadline", sessionID })).toBe(visible)
  })

  test("same-session hot remount starts a new covered layout generation", () => {
    const ready = transition(
      initialSessionRenderState,
      { type: "session-change", sessionID, cached: true },
      { type: "settled", sessionID },
      { type: "overlay-hidden", sessionID },
    )
    const remounted = reduceSessionRenderState(ready, { type: "viewport-bound", sessionID })
    expect(remounted.overlay).toBe("showing")
    expect(remounted.generation).toBe(ready.generation + 1)
    expect(
      reduceSessionRenderState(remounted, { type: "overlay-hidden", sessionID, generation: ready.generation }),
    ).toBe(remounted)
    expect(reduceSessionRenderState(remounted, { type: "settled", sessionID, generation: ready.generation })).toBe(
      remounted,
    )
    expect(reduceSessionRenderState(remounted, { type: "deadline", sessionID, generation: ready.generation })).toBe(
      remounted,
    )
    expect(
      reduceSessionRenderState(remounted, { type: "settled", sessionID, generation: remounted.generation }).overlay,
    ).toBe("hiding")
  })

  test("cache invalidation is not mistaken for an empty but loaded session", () => {
    const ready = transition(
      initialSessionRenderState,
      { type: "session-change", sessionID, cached: true },
      { type: "settled", sessionID },
    )
    const invalidated = reduceSessionRenderState(ready, { type: "messages-invalidated", sessionID })
    expect(invalidated.hasContent).toBe(false)
    expect(invalidated.overlay).toBe("showing")
    expect(sessionContentVisible(invalidated)).toBe(false)
    const reloaded = reduceSessionRenderState(invalidated, { type: "messages-ready", sessionID })
    expect(reloaded.hasContent).toBe(true)
    expect(reloaded.overlay).toBe("showing")
  })

  test("A to B to A rejects callbacks from the first visit to A", () => {
    const first = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      cached: true,
    })
    const returned = transition(
      first,
      { type: "session-change", sessionID: "ses_other", cached: true },
      { type: "session-change", sessionID, cached: true },
    )
    expect(reduceSessionRenderState(returned, { type: "settled", sessionID, generation: first.generation })).toBe(
      returned,
    )
  })

  test("the same session ID in another workspace has a distinct render identity", () => {
    const first = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      sessionKey: "/one/session",
      cached: true,
    })
    const second = reduceSessionRenderState(first, {
      type: "session-change",
      sessionID,
      sessionKey: "/two/session",
      cached: true,
    })
    expect(first.sessionKey).not.toBe(second.sessionKey)
    expect(second.overlay).toBe("showing")
    expect(second.generation).toBeGreaterThan(first.generation)
  })
})
