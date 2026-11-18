import { Context } from "effect"

export const ContextRef = Context.Reference<boolean>("@opencode/ScheduledTaskUnattended", {
  defaultValue: () => false,
})

// Inherited by child fibers, never persisted in session permissions.
export const IMContextRef = Context.Reference<boolean>("@opencode/IMUnattended", {
  defaultValue: () => false,
})

export * as ScheduledTaskUnattended from "./unattended"
export const IMMessageRef = Context.Reference<string | undefined>("@opencode/IMMessage", {
  defaultValue: () => undefined,
})
