/** Delay before dropping the active turn so brief status/message races do not unmount "Sending". */
export const THINKING_STATUS_STICKY_MS = 200

/**
 * Latch the active user-message id: enter immediately, leave only after `stickyMs` of continuous idle.
 * Mirrors the debounced working state in `@opencode-ai/ui` SessionTurn.
 */
export function advanceStickyActiveMessageID(input: {
  previous: string | undefined
  next: string | undefined
  now: number
  clearAt: number | undefined
  stickyMs?: number
}): { id: string | undefined; clearAt: number | undefined } {
  const stickyMs = input.stickyMs ?? THINKING_STATUS_STICKY_MS
  if (input.next) return { id: input.next, clearAt: undefined }
  if (!input.previous) return { id: undefined, clearAt: undefined }
  if (input.clearAt === undefined) return { id: input.previous, clearAt: input.now + stickyMs }
  if (input.now < input.clearAt) return { id: input.previous, clearAt: input.clearAt }
  return { id: undefined, clearAt: undefined }
}

/**
 * While a turn is sticky-active, treat a transient idle as busy so the Thinking row
 * (Sending / Thinking) is not removed for a single frame.
 */
export function displayStatusForThinking(input: {
  status: "idle" | "busy" | "retry"
  stickyActive: boolean
}): "idle" | "busy" | "retry" {
  if (input.status !== "idle") return input.status
  if (input.stickyActive) return "busy"
  return "idle"
}

/** Once the phase advances to thinking, never regress to sending for the same turn. */
export function latchThinkingPhase(
  previous: "sending" | "thinking" | undefined,
  next: "sending" | "thinking",
): "sending" | "thinking" {
  if (previous === "thinking") return "thinking"
  return next
}
