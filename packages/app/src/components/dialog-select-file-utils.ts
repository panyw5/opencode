import type { CommandOption } from "@/context/command"

export const ENTRY_LIMIT = 5

export const COMMON_COMMAND_IDS = [
  "session.recent",
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle",
] as const

export const NEW_SESSION_COMMAND_IDS = [
  "session.recent",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle",
] as const

export const HOME_COMMAND_IDS = [
  "session.recent",
  "project.open",
  "project.switch",
  "settings.open",
  "config.open",
  "provider.connect",
  "server.switch",
  "server.reloadBackend",
  "app.reloadFrontend",
] as const

export function pickCommandOptions(options: CommandOption[], ids: readonly string[]) {
  const order = new Map<string, number>(ids.map((id, index) => [id, index]))
  const picked = options.filter((option) => order.has(option.id))
  if (!picked.length) return options.slice(0, ENTRY_LIMIT)
  return picked.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}
