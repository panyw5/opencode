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
  generation: number
  phase: SessionRenderPhase
  overlay: SessionRenderOverlayStatus
  hasContent: boolean
}

export type SessionRenderEvent =
  | { type: "session-change"; sessionID?: string; cached: boolean }
  | { type: "messages-ready"; sessionID: string }
  | { type: "content-ready"; sessionID: string }
  | { type: "reconcile"; sessionID: string }
  | { type: "settle"; sessionID: string }
  | { type: "settled"; sessionID: string }
  | { type: "deadline"; sessionID: string }
  | { type: "overlay-hidden"; sessionID: string }

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
        generation: state.generation + 1,
        phase: "unresolved",
        overlay: "hidden",
        hasContent: false,
      }
    }
    return {
      sessionID: event.sessionID,
      generation: state.generation + 1,
      phase: event.cached ? "cached-visible" : "fetching",
      overlay: event.cached ? "hidden" : "showing",
      hasContent: event.cached,
    }
  }

  if (state.sessionID !== event.sessionID) return state

  if (event.type === "messages-ready") {
    if (state.hasContent && state.overlay === "hidden") return state
    return {
      ...state,
      phase: state.phase === "cached-visible" ? "reconciling" : "content-visible",
      overlay: state.overlay === "showing" ? "hiding" : state.overlay,
      hasContent: true,
    }
  }
  if (event.type === "content-ready") {
    return {
      ...state,
      phase: state.phase === "cached-visible" ? "reconciling" : "settling",
      overlay: state.overlay === "showing" ? "hiding" : state.overlay,
      hasContent: true,
    }
  }
  if (event.type === "reconcile") return { ...state, phase: "reconciling", hasContent: true }
  if (event.type === "settle") return { ...state, phase: "settling", hasContent: true }
  if (event.type === "settled") return { ...state, phase: "interactive", hasContent: true }
  if (event.type === "deadline") {
    return {
      ...state,
      phase: state.phase === "fetching" && state.hasContent ? "content-visible" : state.phase,
      overlay: state.hasContent ? "hidden" : state.overlay,
    }
  }
  if (event.type === "overlay-hidden") return { ...state, overlay: "hidden" }
  return state
}
