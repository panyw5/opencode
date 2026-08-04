import type { Message, Part, Session, SessionStatus, ToolPart } from "@opencode-ai/sdk/v2/client"
import { taskSessionIndex } from "@opencode-ai/ui/message-task-session"
import { working } from "./session-working"

type SessionChildAgentStatus = Exclude<ToolPart["state"]["status"], "pending">
type SessionChildAgentUsage = "not used"

export type SessionChildAgentEntry = {
  id: string
  sessionID: string
  /** Plain title without #index / 续跑 prefix — UI renders badges separately. */
  title: string
  agent?: string
  description?: string
  created: number
  status?: SessionChildAgentStatus
  usage?: SessionChildAgentUsage
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
 */
function statusFor(
  sessionID: string,
  input: CollectChildAgentEntriesInput,
  toolStatus?: SessionChildAgentStatus,
): SessionChildAgentStatus | undefined {
  const messages = input.messagesBySession?.[sessionID]
  const last = messages?.at(-1)
  if (last?.role === "assistant" && last.error !== undefined) return "error"
  if (working(input.statuses?.[sessionID], messages)) return "running"
  if (last?.role === "assistant" && typeof last.time.completed === "number") return "completed"
  if (toolStatus === "running" || toolStatus === "error") return toolStatus
  if (toolStatus === "completed") return "completed"
}

function entryFromTaskPart(input: {
  part: ToolPart
  message: Message
  sessionByID: Map<string, Session>
  parentSessionID?: string
  sessions: readonly Session[]
  seenSessionIDs: Set<string>
  collect: CollectChildAgentEntriesInput
  order: number
}): (SessionChildAgentEntry & { order: number }) | undefined {
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
    status: statusFor(sessionID, input.collect, toolStatus),
    index: taskSessionIndex({
      childSessionId: sessionID,
      parentSessionId: input.parentSessionID,
      sessions: input.sessions,
    }),
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
  const entries: Array<SessionChildAgentEntry & { order: number }> = []
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
        parentSessionID: input.sessionID,
        sessions: input.sessions,
        seenSessionIDs,
        collect: input,
        order,
      })
      if (!entry) continue
      entries.push(entry)
      order += 1
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
      usage: status === "running" || status === "error" ? undefined : "not used",
      index: taskSessionIndex({
        childSessionId: session.id,
        parentSessionId: input.sessionID,
        sessions: input.sessions,
      }),
      resume: false,
      order,
    })
    order += 1
  }

  return entries
    .toSorted((a, b) => a.created - b.created || a.order - b.order)
    .map(({ order: _order, ...entry }) => entry)
}
