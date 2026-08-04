import type { Permission } from "../permission"
import type { Agent } from "./agent"

/**
 * B2: forward parent-agent edit denies only for Plan Mode parents.
 *
 * Plan Mode's file-edit restriction lives on the plan **agent** ruleset, not
 * the session (#26514). Upstream #31696 (B1) drops all parent-agent edit
 * forwarding so subagents can use their own permissions; B2 keeps Plan Mode
 * safe while allowing build → implement-style agents to edit per frontmatter.
 */
export function isPlanPrimaryAgent(parentAgent: Agent.Info | undefined): boolean {
  if (!parentAgent) return false
  if (parentAgent.name === "plan") return true
  if (parentAgent.mode !== "primary" && parentAgent.mode !== "all") return false
  // Custom plan-mode agents typically expose plan_exit (native plan does too).
  return parentAgent.permission.some((rule) => rule.permission === "plan_exit" && rule.action === "allow")
}

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. Parent **agent** edit deny rules — only when the parent is plan-like (B2).
 * 2. Parent **session** deny rules and external_directory rules.
 * 3. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentAgentDenies = isPlanPrimaryAgent(input.parentAgent)
    ? (input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? [])
    : []
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
