import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"

export function queuedUserMessageIDs(messages: readonly Message[]) {
  const latestAssistant = messages.findLast((message): message is AssistantMessage => message.role === "assistant")
  if (!latestAssistant || typeof latestAssistant.time.completed === "number") return new Set<string>()

  const parentIndex = messages.findIndex((message) => message.id === latestAssistant.parentID)
  if (parentIndex < 0) return new Set<string>()

  return new Set(
    messages
      .slice(parentIndex + 1)
      .filter((message): message is UserMessage => message.role === "user")
      .map((message) => message.id),
  )
}
