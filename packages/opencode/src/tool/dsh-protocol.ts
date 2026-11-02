export type DshEventItem = {
  id: string
  kind: "message" | "user" | "status" | "error" | "thinking" | "tool_use" | "tool_result"
  title?: string
  text?: string
  status?: string
}

export type DshJsonState = {
  sessionId?: string
  answer: string
  completed: boolean
  final: boolean
  error?: string
  sequence: number
  onItem?: (item: DshEventItem) => void
}

export function dshCapabilities(help: string) {
  return { json: /(?:^|\s)--json(?:[\s,]|$)/m.test(help), resume: /--session-id(?:[\s=<]|$)/m.test(help) }
}

export function createDshJsonState(): DshJsonState {
  return { answer: "", completed: false, final: false, sequence: 0 }
}

export function applyDshJsonlLine(state: DshJsonState, line: string): boolean {
  let event: Record<string, unknown>
  try {
    const value = JSON.parse(line)
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    event = value
  } catch {
    return false
  }
  const text = typeof event.text === "string" ? event.text : ""
  const id = "event:" + state.sequence++
  const emit = (item: DshEventItem) => state.onItem?.(item)
  if (event.type === "session") {
    if (typeof event.sessionId === "string") state.sessionId = event.sessionId
    emit({ id, kind: "status", title: "Session started", text: state.sessionId })
  } else if (event.type === "status") {
    if (event.phase === "turn_start") {
      state.completed = false
      state.error = undefined
    }
    if (event.phase === "turn_end") {
      const reason = event.reason as { kind?: string; error?: { message?: string } } | undefined
      state.completed = reason?.kind === "completed"
      if (!state.completed) state.error = reason?.error?.message || "DSH turn ended: " + (reason?.kind ?? "unknown")
    }
    emit({ id, kind: state.error ? "error" : "status", title: String(event.phase ?? "Status"), text: state.error })
  } else if (event.type === "text") {
    emit({ id: "assistant:live", kind: "message", title: "Assistant", text, status: "running" })
  } else if (event.type === "thinking") {
    emit({ id, kind: "thinking", title: "Thinking", text })
  } else if (event.type === "tool_call") {
    emit({
      id: "call:" + String(event.callId ?? id),
      kind: "tool_use",
      title: String(event.tool ?? "Tool"),
      text: JSON.stringify(event.input),
      status: "running",
    })
  } else if (event.type === "tool_result") {
    emit({
      id: "result:" + String(event.callId ?? id),
      kind: "tool_result",
      title: "Tool result",
      text: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
      status: String(event.status ?? "completed"),
    })
  } else if (event.type === "error") {
    state.error = typeof event.message === "string" ? event.message : "DSH stream error"
    state.completed = false
    emit({ id, kind: "error", title: "Error", text: state.error })
  } else if (event.type === "final") {
    state.answer = text
    state.final = true
    // A final payload is also emitted for failed runs; turn_end owns success.
    emit({
      id: "assistant:final",
      kind: "message",
      title: "Assistant",
      text,
      status: state.completed ? "completed" : "error",
    })
  } else return false
  return true
}
