export type SessionRenderPhase =
  | "unresolved"
  | "fetching"
  | "cached-visible"
  | "content-visible"
  | "reconciling"
  | "settling"
  | "interactive"

export type SessionRenderOverlayStatus = "showing" | "hiding" | "hidden"

export type SessionRenderState = {
  sessionID?: string
  sessionKey?: string
  generation: number
  phase: SessionRenderPhase
  overlay: SessionRenderOverlayStatus
  hasContent: boolean
}

export type SessionRenderEvent = (
  | { type: "session-change"; sessionID?: string; sessionKey?: string; cached: boolean; optimistic?: boolean }
  | { type: "viewport-bound"; sessionID: string; optimistic?: boolean }
  | { type: "messages-invalidated"; sessionID: string }
  | { type: "messages-ready"; sessionID: string }
  | { type: "content-ready"; sessionID: string }
  | { type: "reconcile"; sessionID: string }
  | { type: "settle"; sessionID: string }
  | { type: "settled"; sessionID: string }
  | { type: "deadline"; sessionID: string }
  | { type: "overlay-hidden"; sessionID: string }
) & { generation?: number }

export const initialSessionRenderState: SessionRenderState = {
  generation: 0,
  phase: "unresolved",
  overlay: "hidden",
  hasContent: false,
}

export function sessionContentVisible(state: SessionRenderState) {
  return state.hasContent && state.phase !== "unresolved" && state.phase !== "fetching"
}

export function reduceSessionRenderState(state: SessionRenderState, event: SessionRenderEvent): SessionRenderState {
  if (event.type === "session-change") {
    if (!event.sessionID) {
      return {
        sessionID: undefined,
        sessionKey: undefined,
        generation: state.generation + 1,
        phase: "unresolved",
        overlay: "hidden",
        hasContent: false,
      }
    }
    const hasContent = event.cached || event.optimistic === true
    return {
      sessionID: event.sessionID,
      sessionKey: event.sessionKey ?? event.sessionID,
      generation: state.generation + 1,
      phase: hasContent ? "cached-visible" : "fetching",
      // Prefetch caches data, not the new viewport's Markdown or measured layout.
      overlay: event.optimistic ? "hidden" : "showing",
      hasContent,
    }
  }

  if (state.sessionID !== event.sessionID) return state
  if (event.generation !== undefined && state.generation !== event.generation) return state

  if (event.type === "messages-invalidated")
    return { ...state, generation: state.generation + 1, phase: "fetching", overlay: "showing", hasContent: false }
  if (event.type === "viewport-bound")
    return {
      ...state,
      generation: state.generation + 1,
      phase: "settling",
      overlay: event.optimistic ? "hidden" : "showing",
    }

  if (event.type === "messages-ready") {
    if (state.hasContent && state.overlay === "hidden") return state
    return {
      ...state,
      phase: state.phase === "cached-visible" ? "reconciling" : "content-visible",
      overlay: state.overlay,
      hasContent: true,
    }
  }
  if (event.type === "content-ready") {
    return {
      ...state,
      phase: state.phase === "cached-visible" ? "reconciling" : "settling",
      overlay: state.overlay,
      hasContent: true,
    }
  }
  if (event.type === "reconcile") return { ...state, phase: "reconciling", hasContent: true }
  if (event.type === "settle") return { ...state, phase: "settling", hasContent: true }
  if (event.type === "settled")
    return {
      ...state,
      phase: "interactive",
      overlay: state.overlay === "showing" ? "hiding" : state.overlay,
      hasContent: true,
    }
  if (event.type === "deadline") {
    if (!state.hasContent) return state
    return {
      ...state,
      phase: state.phase === "fetching" && state.hasContent ? "content-visible" : state.phase,
      overlay: state.hasContent ? "hidden" : state.overlay,
    }
  }
  if (event.type === "overlay-hidden") return { ...state, overlay: "hidden" }
  return state
}
