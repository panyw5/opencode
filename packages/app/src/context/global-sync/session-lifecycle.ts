import type { Session } from "@opencode-ai/sdk/v2/client"

export type SessionLifecycleEvent = {
  type: "archived" | "deleted" | "restored"
  directory: string
  session: Session
}

const listeners = new Set<(event: SessionLifecycleEvent) => void>()

export function publishSessionLifecycle(event: SessionLifecycleEvent) {
  for (const listener of listeners) listener(event)
}

export function onSessionLifecycle(listener: (event: SessionLifecycleEvent) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
