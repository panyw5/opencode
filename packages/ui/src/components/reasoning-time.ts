import type { AssistantMessage, ReasoningPart } from "@opencode-ai/sdk/v2"

export function reasoningElapsedMs(part: ReasoningPart, message: AssistantMessage, now: number): number | undefined {
  const start = part.time?.start
  if (typeof start !== "number" || !Number.isFinite(start)) return undefined

  const end = part.time.end ?? message.time.completed ?? now
  if (typeof end !== "number" || !Number.isFinite(end) || end < start) return undefined
  return end - start
}
