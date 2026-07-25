import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

export function formatThinkingElapsed(seconds: number) {
  const tenths = Math.max(0, Math.floor(seconds * 10))
  if (tenths < 600) return (tenths / 10).toFixed(1)
  const minutes = Math.floor(tenths / 600)
  const remainder = tenths % 600
  return { minutes, seconds: (remainder / 10).toFixed(1) } as const
}

export function hiddenReasoning(
  msgs: AssistantMessage[],
  parts: Record<string, Part[] | undefined>,
  show: boolean,
) {
  if (show) return false

  return msgs.some((msg) => (parts[msg.id] ?? []).some((part) => part.type === "reasoning" && !!part.text?.trim()))
}
