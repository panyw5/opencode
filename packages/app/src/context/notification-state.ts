import type { EventSessionError } from "@opencode-ai/sdk/v2"
import type { Session } from "@opencode-ai/sdk/v2/client"

type NotificationBase = {
  directory?: string
  session?: string
  metadata?: unknown
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  issueID?: string
  error: EventSessionError["properties"]["error"]
}

type ActionNeededNotification = NotificationBase & {
  type: "question" | "permission"
}

export type Notification = TurnCompleteNotification | ErrorNotification | ActionNeededNotification

export function shouldNotifySuccessfulTurn(message: { role: string; finish?: string; error?: unknown } | undefined) {
  return message?.role === "assistant" && !message.error && message.finish === "stop"
}

export function shouldNotifyTurnComplete(
  session: Pick<Session, "parentID" | "time"> | undefined,
): session is Pick<Session, "parentID" | "time"> {
  if (!session) return false
  if (session.parentID) return false
  if (session.time.archived) return false
  return true
}

export function markCurrentNotifications(list: Notification[], session: string, directory: string) {
  let changed = false
  const next = list.map((item) => {
    if (item.session !== session) return item
    if (item.directory !== directory) return item
    if (item.viewed) return item
    if (item.type === "error" && item.issueID) return item
    changed = true
    return {
      ...item,
      viewed: true,
    }
  })
  return changed ? next : list
}
