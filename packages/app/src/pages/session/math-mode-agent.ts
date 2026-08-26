export const MATH_ORCHESTRATOR_AGENT = "math-orchestrator"

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
