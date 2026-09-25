export const MATH_ORCHESTRATOR_AGENT = "math-orchestrator"

export function mathModeIsInitializing(input: {
  sessionID?: string
  requestedSessionID?: string
  workerCount: number
  sessionAgent?: string
  sessionWorking?: boolean
}): boolean {
  if (!input.sessionID || input.workerCount > 0) return false
  if (input.sessionID === input.requestedSessionID) return true
  return input.sessionAgent === MATH_ORCHESTRATOR_AGENT && input.sessionWorking === true
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
