import { object, type PiRecord } from "./rpc"
import type { TranscriptItem } from "@/session/external"

export function piText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .flatMap((entry) => {
      const item = object(entry)
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : []
    })
    .join("\n")
}

export class PiTranscript {
  onTranscript?: (item: TranscriptItem) => void
  transcript: TranscriptItem[] = []
  private sequence = 0
  private users = 0
  private current = 0
  private blocks = new Map<number, string>()
  private replies = new Map<number, string>()

  beginTurn() {
    this.replies.clear()
  }

  get text() {
    return [...this.replies.values()].filter(Boolean).join("\n\n")
  }

  apply(event: PiRecord) {
    const message = object(event.message)
    if (event.type === "message_start") {
      if (message?.role === "assistant") {
        this.current = ++this.sequence
        this.blocks.clear()
      }
      if (message?.role === "user") {
        const index = this.users++
        // The external-session projector already creates the original user turn.
        if (index > 0)
          this.put({ id: `user:${index}`, kind: "user", text: piText(message.content), status: "completed" })
      }
    }
    if (event.type === "message_update") {
      const update = object(event.assistantMessageEvent)
      if (!update || typeof update.contentIndex !== "number") return
      const index = update.contentIndex
      const type = String(update.type)
      if (!["text_delta", "text_end", "thinking_delta", "thinking_end"].includes(type)) return
      const text = type.endsWith("_end")
        ? String(update.content ?? "")
        : (this.blocks.get(index) ?? "") + String(update.delta ?? "")
      this.blocks.set(index, text)
      this.put({
        id: `message:${this.current}:${index}`,
        kind: type.startsWith("thinking") ? "thinking" : "message",
        text,
        status: type.endsWith("_end") ? "completed" : "running",
      })
    }
    if (event.type === "message_end" && message?.role === "assistant") {
      this.replies.set(this.current, piText(message.content))
      const failed = message.stopReason === "error" || message.stopReason === "aborted"
      if (Array.isArray(message.content))
        message.content.forEach((raw, index) => {
          const block = object(raw)
          if (block?.type !== "text" && block?.type !== "thinking") return
          this.put({
            id: `message:${this.current}:${index}`,
            kind: block.type === "thinking" ? "thinking" : "message",
            text: String(block.text ?? block.thinking ?? ""),
            status: failed ? "error" : "completed",
          })
        })
      if (failed)
        this.put({
          id: `error:${this.current}`,
          kind: "error",
          title: "Pi response failed",
          text: String(message.errorMessage ?? message.stopReason),
          status: "error",
        })
    }
    if (event.type.startsWith("tool_execution_")) {
      const result = object(event.result ?? event.partialResult)
      const done = event.type === "tool_execution_end"
      this.put({
        id: `tool:${event.toolCallId}`,
        kind: "tool_use",
        title: String(event.toolName ?? "Pi tool"),
        text: result ? piText(result.content) : JSON.stringify(event.args ?? {}),
        status: done ? (event.isError ? "error" : "completed") : "running",
      })
    }
    if (
      [
        "compaction_start",
        "compaction_end",
        "auto_retry_start",
        "auto_retry_end",
        "extension_error",
        "extension_ui_request",
      ].includes(event.type)
    ) {
      this.put({
        id: `status:${++this.sequence}`,
        kind: "status",
        title: event.type,
        text: String(event.errorMessage ?? event.message ?? event.method ?? ""),
        status: "completed",
      })
    }
  }

  private put(item: TranscriptItem) {
    this.onTranscript?.(item)
    const retained = { ...item, text: item.text?.slice(0, 8000) }
    const index = this.transcript.findIndex((entry) => entry.id === item.id)
    if (index === -1) this.transcript.push(retained)
    else this.transcript[index] = retained
    if (this.transcript.length > 80) this.transcript.splice(0, this.transcript.length - 80)
  }
}
