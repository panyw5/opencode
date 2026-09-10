import type { SessionID } from "@/session/schema"

export function injectedPrompt(input: { prompt: string; previousSessionID?: SessionID }) {
  if (!input.previousSessionID) return input.prompt
  return `<scheduled-task-context previous_session_id="${input.previousSessionID}" />\n\n${input.prompt}`
}

export * as ScheduledTaskPrompt from "./prompt"
