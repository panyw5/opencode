import type { MessageV2 } from "./message-v2"

export const MAX_OUTPUT_LIMIT_CONTINUATIONS = 2
export const OUTPUT_LIMIT_PROMPT =
  "Your last response hit the output token limit (stop reason: length). Continue from where you left off without apologizing, recapping, or repeating completed content. Break the remaining work into smaller pieces and reissue any incomplete tool call with complete arguments."

export function outputLimitStreak(messages: ReadonlyArray<{ info: MessageV2.Info }>) {
  let count = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const info = messages[index].info
    if (info.role !== "assistant" || info.finish !== "length") break
    count++
  }
  return count
}
