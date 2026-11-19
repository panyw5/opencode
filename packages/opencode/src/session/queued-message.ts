import type { MessageV2 } from "./message-v2"
import type { SessionStatus } from "./status"

/**
 * A queued prompt is a user message the running turn has not consumed yet.
 * Deleting it while the session is busy is safe; the busy guard exists to
 * protect turns that already started.
 */
export function isQueuedPrompt(input: {
  status: SessionStatus.Info
  message: Pick<MessageV2.Info, "role" | "time"> | undefined
}) {
  if (input.status.type === "idle") return false
  if (input.message?.role !== "user") return false
  return !("completed" in input.message.time)
}

export * as SessionQueuedMessage from "./queued-message"
