// Policies shared by the tab and its stable render boundary. Self-reading is
// opt-in and only replace viewers may bypass the host's text loading gate.
export type FileViewerContentPolicy = { mode: "replace" | "preview"; content?: "text" | "self" }

export function fileViewerReadsSelf(viewer: FileViewerContentPolicy | undefined): boolean {
  return viewer?.mode === "replace" && viewer.content === "self"
}

export function fileViewerCanMount(viewer: FileViewerContentPolicy | undefined, loaded: boolean): boolean {
  return !!viewer && (fileViewerReadsSelf(viewer) || loaded)
}

export function fileViewerSwitchAllowed(dirty: boolean, active: string | undefined, next: string): boolean {
  return !dirty || active === next
}

export type FileViewerRevision = {
  mode: "self" | "text" | undefined
  value: string | number | undefined
  revision: number
}

// Establish a baseline on mount/mode changes; a cached value is not a change.
export function advanceFileViewerRevision(
  previous: FileViewerRevision | undefined,
  mode: FileViewerRevision["mode"],
  value: FileViewerRevision["value"],
): FileViewerRevision {
  const changed = previous && mode !== undefined && previous.mode === mode && previous.value !== value
  return { mode, value, revision: (previous?.revision ?? 0) + (changed ? 1 : 0) }
}

export function fileViewerSelectionRequest(input: {
  path: string
  seq: number
  active: boolean
  pending: boolean
  hasRange: boolean
  handled?: { path: string; seq: number }
}): boolean {
  return (
    input.active &&
    input.pending &&
    input.hasRange &&
    (input.handled?.path !== input.path || input.handled.seq !== input.seq)
  )
}
