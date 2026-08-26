type AgentInfo = {
  name: string
  mode: string
  hidden?: boolean
}

export function primaryAgents<T extends AgentInfo>(items: T[]): T[] {
  return items.filter((item) => item.mode !== "subagent")
}

export function selectableAgents<T extends AgentInfo>(items: T[]): T[] {
  return primaryAgents(items).filter((item) => !item.hidden)
}

export function internalAgent<T extends AgentInfo>(items: T[], name: string | undefined): T | undefined {
  if (!name) return undefined
  return primaryAgents(items).find((item) => item.name === name)
}
