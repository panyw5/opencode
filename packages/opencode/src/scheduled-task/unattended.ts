import { Context } from "effect"

export const ContextRef = Context.Reference<boolean>("@opencode/ScheduledTaskUnattended", {
  defaultValue: () => false,
})

export * as ScheduledTaskUnattended from "./unattended"
