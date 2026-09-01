export const ALL_TOOLS = ["gm_add", "gm_search", "fact_submit", "fact_search", "fact_get", "fact_revoke"] as const

export type MathToolName = (typeof ALL_TOOLS)[number]

export type MathRole = "worker" | "orchestrator" | "verifier" | "all"

const ROLE_TOOLS: Record<MathRole, readonly MathToolName[]> = {
  worker: ["gm_add", "gm_search", "fact_submit", "fact_search", "fact_get"],
  orchestrator: ["gm_add", "gm_search", "fact_search", "fact_get", "fact_revoke"],
  verifier: [],
  all: ALL_TOOLS,
}

export function normalizeRole(role: string | undefined): MathRole {
  if (role === "main") return "orchestrator"
  if (role === "worker" || role === "orchestrator" || role === "verifier" || role === "all") return role
  return "verifier"
}

/**
 * Tools a role may even see. Unknown / unset fails closed to verifier
 * (no writes). Orchestrator never gets `fact_submit`.
 */
export function toolsFor(role: string | undefined): MathToolName[] {
  return [...ROLE_TOOLS[normalizeRole(role)]]
}

export function roleMay(role: string | undefined, tool: string): boolean {
  return toolsFor(role).some((name) => name === tool)
}

export * as MathRoles from "./roles"
