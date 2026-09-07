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
  test("shows cached content without creating an overlay", () => {
    const state = reduceSessionRenderState(initialSessionRenderState, {
      type: "session-change",
      sessionID,
      cached: true,
    })
    expect(state.phase).toBe("cached-visible")
    expect(state.overlay).toBe("hidden")
    expect(sessionContentVisible(state)).toBe(true)
  })

  test("only shows the overlay while an uncached session has no content", () => {
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
    expect(visible.overlay).toBe("hiding")
    expect(sessionContentVisible(visible)).toBe(true)
  })

  test("keeps content visible while reconciling and settling", () => {
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
    )
    expect(state.phase).toBe("interactive")
    expect(state.overlay).toBe("hidden")
    expect(sessionContentVisible(state)).toBe(true)
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
    expect(reduceSessionRenderState(interactive, { type: "deadline", sessionID }).phase).toBe("interactive")
  })
})
