export type ModelKey = { providerID: string; modelID: string }

export type ModelSelection = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

export type AgentChoice = {
  name: string
  model?: ModelKey
  variant?: string
}

export function activeSelection(input: {
  sessionID?: string
  manual?: ModelSelection
  restored?: ModelSelection
  draft?: ModelSelection
  promoting?: ModelSelection
}) {
  if (input.sessionID) return input.manual ?? input.restored
  return input.draft ?? input.promoting
}

export function selectModel(current: ModelSelection | undefined, model: ModelKey | undefined): ModelSelection {
  return {
    ...current,
    model,
    variant: null,
  }
}

export function selectVariant(current: ModelSelection | undefined, variant: string | null): ModelSelection {
  return {
    ...current,
    variant,
  }
}

export function selectAgent(current: ModelSelection | undefined, agent: AgentChoice): ModelSelection {
  if (current?.agent === agent.name) return current
  if (!agent.model) return { ...current, agent: agent.name }
  return {
    agent: agent.name,
    model: agent.model,
    variant: agent.variant ?? null,
  }
}

export function restoreMessageSelection(input: {
  manual?: ModelSelection
  handoff?: ModelSelection
  message: ModelSelection
}) {
  if (input.manual || input.handoff) return undefined
  return input.message
}
