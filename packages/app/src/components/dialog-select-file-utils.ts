import type { CommandOption } from "@/context/command"

const ENTRY_LIMIT = 5

export function pickCommandOptions(options: CommandOption[], ids: readonly string[]) {
  const order = new Map<string, number>(ids.map((id, index) => [id, index]))
  const picked = options.filter((option) => order.has(option.id))
  if (!picked.length) return options.slice(0, ENTRY_LIMIT)
  return picked.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}
