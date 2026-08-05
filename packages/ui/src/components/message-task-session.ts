import type { Session, ToolPart } from "@opencode-ai/sdk/v2"

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const next = value.trim()
  if (!next) return undefined
  return next
}

function taskStartTime(part: ToolPart | undefined): number | undefined {
  const state = part?.state
  if (!state || state.status === "pending") return undefined
  return state.time.start
}

/** Whole elapsed seconds for a task invocation, fixed once the tool records its end time. */
export function taskElapsedSeconds(input: { start?: number; end?: number; now?: number }): number | undefined {
  if (typeof input.start !== "number") return undefined
  const stop = input.end ?? input.now
  if (typeof stop !== "number") return undefined
  return Math.max(0, Math.floor((stop - input.start) / 1000))
}

/**
 * Resolve the wall-clock span shown on a task tool card.
 *
 * Background tasks complete the parent tool part almost immediately (end ≈ start),
 * while the child session keeps running. Prefer the child session's lifecycle so
 * the duration badge keeps ticking and settles on the real completion time.
 */
export function taskElapsedBounds(input: {
  toolStatus?: "pending" | "running" | "completed" | "error"
  toolStart?: number
  toolEnd?: number
  background?: boolean
  childCreated?: number
  /** Latest assistant message completion time in the child session. */
  childCompleted?: number
  /** Session.time.updated for the child (fallback end when messages are missing). */
  childUpdated?: number
  /** True when the child session is still busy/retrying. */
  childBusy?: boolean
}): { start?: number; end?: number } {
  const toolLive = input.toolStatus === "pending" || input.toolStatus === "running"
  const toolStart = typeof input.toolStart === "number" ? input.toolStart : undefined
  const toolEnd = !toolLive && typeof input.toolEnd === "number" ? input.toolEnd : undefined
  const start = toolStart ?? (typeof input.childCreated === "number" ? input.childCreated : undefined)
  if (typeof start !== "number") return {}

  if (toolLive || input.childBusy) {
    return { start, end: undefined }
  }

  if (typeof input.childCompleted === "number") {
    return { start, end: Math.max(start, input.childCompleted) }
  }

  // Background tools often finish in a few ms while the child keeps working.
  // Prefer session.updated over the instantaneous tool end; if even that is
  // missing/stale, keep counting live rather than freezing at 0s.
  if (
    input.background === true &&
    typeof toolStart === "number" &&
    typeof toolEnd === "number" &&
    toolEnd - toolStart < 2_000
  ) {
    if (typeof input.childUpdated === "number" && input.childUpdated > start + 2_000) {
      return { start, end: input.childUpdated }
    }
    return { start, end: undefined }
  }

  if (typeof toolEnd === "number") return { start, end: Math.max(start, toolEnd) }
  return { start, end: undefined }
}

function taskTitleMatches(session: Session, description: string | undefined): boolean {
  if (!description) return false
  const title = text(session.title)
  if (!title) return false
  return title === description || title.startsWith(`${description} (@`)
}

export function resolveTaskChildSessionId(input: {
  metadata?: Record<string, unknown>
  tool?: ToolPart
  input?: Record<string, unknown>
  sessions?: readonly Session[]
}): string | undefined {
  const direct = text(input.metadata?.sessionId) ?? text(input.metadata?.sessionID)
  if (direct) return direct

  const parentID = input.tool?.sessionID
  if (!parentID) return undefined

  const toolInput = input.input ?? input.tool?.state.input ?? {}
  const description = text(toolInput.description)
  const agent = text(toolInput.subagent_type) ?? text(toolInput.agent)
  const children = (input.sessions ?? []).filter((session) => {
    if (session.parentID !== parentID) return false
    return !session.time.archived
  })
  if (children.length === 0) return undefined

  const titleMatches = children.filter((session) => taskTitleMatches(session, description))
  const agentMatches = agent ? children.filter((session) => text(session.agent) === agent) : []
  const candidates = titleMatches.length > 0 ? titleMatches : children.length === 1 ? children : agentMatches
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]?.id

  const start = taskStartTime(input.tool)
  if (start === undefined) return undefined
  return candidates.toSorted((a, b) => Math.abs(a.time.created - start) - Math.abs(b.time.created - start))[0]?.id
}

export function taskSessionSiblings(input: { parentSessionId?: string; sessions?: readonly Session[] }): Session[] {
  const parentSessionId = text(input.parentSessionId)
  if (!parentSessionId) return []

  return (input.sessions ?? [])
    .filter((session) => session.parentID === parentSessionId && !session.time.archived)
    .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
}

export function taskSessionNeighbors(input: {
  childSessionId?: string
  parentSessionId?: string
  sessions?: readonly Session[]
}): { previous?: Session; next?: Session } | undefined {
  const childSessionId = text(input.childSessionId)
  if (!childSessionId) return

  const siblings = taskSessionSiblings(input)
  const index = siblings.findIndex((session) => session.id === childSessionId)
  if (index < 0) return
  return {
    previous: siblings[index - 1],
    next: siblings[index + 1],
  }
}

/** 1-based index of a child subagent session among siblings of the same parent. */
export function taskSessionIndex(input: {
  childSessionId?: string
  parentSessionId?: string
  sessions?: readonly Session[]
}): number | undefined {
  const childSessionId = text(input.childSessionId)
  const parentSessionId = text(input.parentSessionId)
  if (!childSessionId || !parentSessionId) return undefined

  const siblings = taskSessionSiblings(input)

  const index = siblings.findIndex((session) => session.id === childSessionId)
  if (index < 0) return undefined
  return index + 1
}

/** True when this task call resumes an existing child session via task_id. */
export function isTaskResume(input?: Record<string, unknown>): boolean {
  return text(input?.task_id) !== undefined
}

/** Stable badge for a child subagent session, e.g. "#3" or "#3 续跑". */
export function taskSessionBadge(index: number | undefined, resume?: boolean): string | undefined {
  if (index === undefined) return undefined
  return resume ? `#${index} 续跑` : `#${index}`
}

/** Prefix agent/menu title with a stable session badge. */
export function withTaskSessionIndex(
  title: string,
  index: number | undefined,
  options?: { resume?: boolean },
): string {
  const badge = taskSessionBadge(index, options?.resume === true)
  if (!badge) return title
  if (!title) return badge
  return `${badge} ${title}`
}
