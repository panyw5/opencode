import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentEvent } from "./backend"

/** Adapts ACP updates to the same append/patch stream consumed by external child sessions. */
export class AcpTranscript {
  readonly transcript: AgentEvent[] = []
  onTranscript?: (item: AgentEvent) => void
  text = ""
  private turn = 0
  private sequence = 0
  private chunk?: AgentEvent
  private items = new Map<string, AgentEvent>()

  beginTurn(message: string) {
    this.turn++
    this.text = ""
    this.chunk = undefined
    if (this.turn > 1) this.put({ id: `${this.turn}:user`, kind: "user", text: message })
  }

  private put(item: AgentEvent) {
    // Persist the full patch before limiting the in-memory/UI preview.
    this.onTranscript?.({ ...item })
    const previous = this.items.get(item.id)
    const merged = { ...previous, ...item, ...(item.text != null ? { text: item.text.slice(0, 8000) } : {}) }
    this.items.set(item.id, merged)
    if (previous) this.transcript[this.transcript.indexOf(previous)] = merged
    else this.transcript.push(merged)
    if (this.transcript.length > 80) {
      const removed = this.transcript.shift()!
      this.items.delete(removed.id)
    }
  }

  apply({ update }: SessionNotification) {
    const type = update.sessionUpdate
    if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
      const kind = type === "agent_message_chunk" ? "message" : "reasoning"
      const content = update.content
      const text = content.type === "text" ? content.text : `[${content.type}]`
      if (kind === "message") this.text += text
      if (!this.chunk || this.chunk.kind !== kind)
        this.chunk = { id: `${this.turn}:chunk:${++this.sequence}`, kind, text: "" }
      this.chunk.text += text
      this.put(this.chunk)
      return
    }
    // Tool boundaries split text chunks so later text is not moved before a tool.
    this.chunk = undefined
    if (type === "tool_call" || type === "tool_call_update") {
      const status = update.status
      const content = update.content
        ?.map((item) => {
          if (item.type === "content" && item.content.type === "text") return item.content.text
          return JSON.stringify(item)
        })
        .join("\n")
      this.put({
        id: `${this.turn}:tool:${update.toolCallId}`,
        kind: "tool",
        ...(update.title != null ? { title: update.title } : {}),
        ...(content != null ? { text: content } : {}),
        ...(status ? { status: status === "in_progress" ? "running" : status === "failed" ? "error" : status } : {}),
      })
    } else if (type === "plan") {
      this.put({
        id: `${this.turn}:plan`,
        kind: "plan",
        title: "Plan",
        text: update.entries.map((item) => `[${item.status}] ${item.content}`).join("\n"),
      })
    } else if (type !== "user_message_chunk") {
      this.put({ id: `${this.turn}:${type}`, kind: "status", title: type, text: JSON.stringify(update) })
    }
  }
}
