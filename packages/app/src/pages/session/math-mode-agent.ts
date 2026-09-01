export const MATH_ORCHESTRATOR_AGENT = "math-orchestrator"

export function mathModeIsAvailable(input: {
  sessionID?: string
  sessionLoaded: boolean
  parentSessionID?: string
  agentAvailable: boolean
}): boolean {
  if (!input.agentAvailable) return false
  if (!input.sessionID) return true
  if (!input.sessionLoaded) return false
  return !input.parentSessionID
}

export function mathModeIsInitializing(input: {
  sessionID?: string
  requestedSessionID?: string
  workerCount: number
}): boolean {
  return Boolean(input.sessionID && input.sessionID === input.requestedSessionID && input.workerCount === 0)
}

export function mathModeLocksAgent(input: {
  prepared: boolean
  sessionAgent?: string
  childAgents: Array<string | undefined>
  subagent: boolean
}): boolean {
  if (input.subagent) return false
  if (input.prepared) return true
  if (input.sessionAgent === MATH_ORCHESTRATOR_AGENT) return true
  return input.childAgents.includes("math-worker")
}
