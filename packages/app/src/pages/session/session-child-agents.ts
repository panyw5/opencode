import type { Message, Part, Session, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2/client"
import { working } from "./session-working"

type SessionChildAgentStatus = Exclude<ToolPart["state"]["status"], "pending"> | "interrupted" | "unknown"

export type SessionChildAgentEntry = {
  id: string
  sessionID: string
  /** Plain title without #index / 续跑 prefix — UI renders badges separately. */
  title: string
  agent?: string
  description?: string
  created: number
  status?: SessionChildAgentStatus
  index?: number
  resume?: boolean
  /** True when the task tool launched with background=true or was promoted. */
  background?: boolean
}

type CollectChildAgentEntriesInput = {
  sessionID?: string
  messages: readonly Message[]
  parts: Record<string, readonly Part[] | undefined>
  sessions: readonly Session[]
  messagesBySession?: Record<string, readonly Message[] | undefined>
  statuses?: Record<string, SessionStatus | undefined>
}

const taskTool = (part: Part): part is ToolPart => part.type === "tool" && part.tool.trim().toLowerCase() === "task"

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return
  const next = value.trim()
  return next || undefined
}

const stateMetadata = (state: ToolPart["state"]): Record<string, unknown> | undefined => {
  if (state.status === "pending") return
  return state.metadata
}

const stateStart = (state: ToolPart["state"]): number | undefined => {
  if (state.status === "pending") return
  return state.time.start
}

const stateTitle = (state: ToolPart["state"]): string | undefined => {
  if (!("title" in state)) return
  return text(state.title)
}

const sessionTitle = (
  session: Session | undefined,
  description: string | undefined,
  agent: string | undefined,
): string => {
  const title = text(session?.title)
  if (title) return title
  if (description) return description
  if (agent) return `@${agent}`
  return "Subagent"
}

/**
 * Resolve entry status. Shared for foreground and background tasks.
 * Child session activity wins over parent tool status (background/promote
 * completes the parent tool immediately while the child may still run).
 * When `before` is set the entry describes a superseded invocation of a
 * resumed session: only messages created before the next invocation belong
 * to it, and live session state no longer applies.
 */
function statusFor(
  sessionID: string,
  input: CollectChildAgentEntriesInput,
  toolStatus?: SessionChildAgentStatus,
  background = false,
  before?: number,
): SessionChildAgentStatus {
  const loaded = input.messagesBySession?.[sessionID]
  const messages = before === undefined ? loaded : loaded?.filter((message) => message.time.created < before)
  const last = messages?.at(-1)
  if (last?.role === "assistant" && last.error?.name === "MessageAbortedError") return "interrupted"
  if (last?.role === "assistant" && last.error !== undefined) return "error"
  if (before === undefined && working(input.statuses?.[sessionID], messages)) return "running"
  if (last?.role === "assistant" && typeof last.time.completed === "number") return "completed"
  if (before !== undefined && last?.role === "assistant") return "interrupted"
  if (toolStatus === "error") return "error"
  if (before === undefined && toolStatus === "running") return "running"
  // Background dispatch completing does not prove that the child finished.
  if (toolStatus === "completed" && !background) return "completed"
  return "unknown"
}

function entryFromTaskPart(input: {
  part: ToolPart
  message: Message
  sessionByID: Map<string, Session>
  childIndexByID: Map<string, number>
  seenSessionIDs: Set<string>
  collect: CollectChildAgentEntriesInput
  order: number
}): (SessionChildAgentEntry & { order: number; toolStatus?: SessionChildAgentStatus }) | undefined {
  const metadata = stateMetadata(input.part.state)
  const sessionID = text(metadata?.sessionId) ?? text(metadata?.sessionID)
  if (!sessionID) return

  const description = text(input.part.state.input.description) ?? stateTitle(input.part.state)
  const agent = text(input.part.state.input.subagent_type) ?? text(input.part.state.input.agent)
  const session = input.sessionByID.get(sessionID)
  const resume = text(input.part.state.input.task_id) !== undefined || input.seenSessionIDs.has(sessionID)
  const background = metadata?.background === true
  input.seenSessionIDs.add(sessionID)

  const toolStatus = input.part.state.status === "pending" ? undefined : input.part.state.status

  return {
    id: `tool:${input.part.messageID}:${input.part.id}:${sessionID}`,
    sessionID,
    title: sessionTitle(session, description, agent),
    agent: agent ?? text(session?.agent),
    description,
    created: stateStart(input.part.state) ?? session?.time.created ?? input.message.time.created,
    status: statusFor(sessionID, input.collect, toolStatus, background),
    toolStatus,
    index: input.childIndexByID.get(sessionID),
    resume,
    background: background || undefined,
    order: input.order,
  }
}

export function collectSessionChildAgentEntries(input: CollectChildAgentEntriesInput): SessionChildAgentEntry[] {
  const childSessions = input.sessions.filter(
    (session) => input.sessionID !== undefined && session.parentID === input.sessionID,
  )
  const sessionByID = new Map(childSessions.map((session) => [session.id, session] as const))
  const childIndexByID = new Map(
    childSessions
      .filter((session) => !session.time.archived)
      .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
      .map((session, index) => [session.id, index + 1] as const),
  )
  const entries: Array<SessionChildAgentEntry & { order: number; toolStatus?: SessionChildAgentStatus }> = []
  let order = 0
  const seenSessionIDs = new Set<string>()

  for (const message of input.messages) {
    const parts = input.parts[message.id] ?? []
    for (const part of parts) {
      if (!taskTool(part)) continue
      const entry = entryFromTaskPart({
        part,
        message,
        sessionByID,
        childIndexByID,
        seenSessionIDs,
        collect: input,
        order,
      })
      if (!entry) continue
      entries.push(entry)
      order += 1
    }
  }

  // Entries sharing a session are separate invocations of a resumed task.
  // Only the newest can be live; re-resolve older entries against the
  // messages that preceded the next invocation.
  const bySession = new Map<string, typeof entries>()
  for (const entry of entries) {
    const list = bySession.get(entry.sessionID)
    if (list) list.push(entry)
    else bySession.set(entry.sessionID, [entry])
  }
  for (const list of bySession.values()) {
    const ordered = list.toSorted((a, b) => a.created - b.created || a.order - b.order)
    for (const [index, entry] of ordered.entries()) {
      const next = ordered[index + 1]
      if (next === undefined) continue
      entry.status = statusFor(entry.sessionID, input, entry.toolStatus, entry.background === true, next.created)
    }
  }

  const sessionIDs = new Set(entries.map((entry) => entry.sessionID))
  for (const session of childSessions) {
    if (sessionIDs.has(session.id)) continue
    const status = statusFor(session.id, input)
    entries.push({
      id: `session:${session.id}`,
      sessionID: session.id,
      title: sessionTitle(session, undefined, text(session.agent)),
      agent: text(session.agent),
      created: session.time.created,
      status,
      index: childIndexByID.get(session.id),
      resume: false,
      order,
    })
    order += 1
  }

  return entries
    .toSorted((a, b) => a.created - b.created || a.order - b.order)
    .map(({ order: _order, toolStatus: _toolStatus, ...entry }) => entry)
}
