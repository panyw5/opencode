export type SessionDataMutation = {
  sessionID: string
  kind: "messages" | "todo" | "diff"
  strategy: "merge" | "discard"
}

export function sessionDataMutation(
  event: { type: string; properties?: unknown },
  sessionForMessage: (messageID: string) => string | undefined,
): SessionDataMutation | undefined {
  const props = (event.properties ?? {}) as Record<string, unknown>
  if (event.type === "session.diff") {
    const sessionID = props.sessionID
    return typeof sessionID === "string" ? { sessionID, kind: "diff", strategy: "discard" } : undefined
  }
  if (event.type === "todo.updated") {
    const sessionID = props.sessionID
    return typeof sessionID === "string" ? { sessionID, kind: "todo", strategy: "discard" } : undefined
  }
  if (event.type === "message.updated") {
    const sessionID = (props.info as { sessionID?: unknown } | undefined)?.sessionID
    return typeof sessionID === "string" ? { sessionID, kind: "messages", strategy: "merge" } : undefined
  }
  if (event.type === "message.part.updated") {
    const sessionID = (props.part as { sessionID?: unknown } | undefined)?.sessionID
    return typeof sessionID === "string" ? { sessionID, kind: "messages", strategy: "merge" } : undefined
  }
  if (
    event.type === "message.list.updated" ||
    event.type === "message.removed" ||
    event.type === "message.part.delta"
  ) {
    const sessionID = props.sessionID
    if (typeof sessionID === "string") {
      const strategy = event.type === "message.part.delta" ? "merge" : "discard"
      return { sessionID, kind: "messages", strategy }
    }
  }
  if (event.type === "message.part.removed" || event.type === "message.part.delta") {
    const messageID = props.messageID
    if (typeof messageID !== "string") return
    const sessionID = sessionForMessage(messageID)
    return sessionID
      ? { sessionID, kind: "messages", strategy: event.type === "message.part.delta" ? "merge" : "discard" }
      : undefined
  }
}
