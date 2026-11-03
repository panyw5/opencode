import { PermissionV2 } from "./permission"

// Scope markers contain exact session IDs, never paths or wildcard grants.
// Only the backend's built-in read/glob/grep permission checks consume them.
export const PROJECT_READ_PERMISSION = "session_context_files"

export function linkedSessionIDs(rules: PermissionV2.Ruleset = []) {
  return [...new Set(rules.filter((rule) => rule.permission === "session_transcript").map((rule) => rule.pattern))]
    .filter((id) => /^ses_[a-zA-Z0-9]+$/.test(id))
    .filter((id) => PermissionV2.evaluate("session_transcript", id, rules).action === "allow")
}

export function projectReadAllowed(rules: PermissionV2.Ruleset = [], sessionID: string) {
  return (
    linkedSessionIDs(rules).includes(sessionID) &&
    rules.findLast((rule) => rule.permission === PROJECT_READ_PERMISSION && rule.pattern === sessionID)?.action ===
      "allow" &&
    PermissionV2.evaluate(PROJECT_READ_PERMISSION, sessionID, rules).action === "allow"
  )
}

export function sessionContextRules(
  previous: PermissionV2.Ruleset,
  references: { sessionID: string; readFiles: boolean }[],
): PermissionV2.Rule[] {
  // The update endpoint appends rules. Return only changed grants to keep long
  // assistant conversations from growing another full ruleset on every message.
  const reset =
    !previous.some((rule) => rule.permission === "session_transcript" && rule.pattern === "*") ||
    PermissionV2.evaluate("session_transcript", "*", previous).action !== "ask"
  const existing = linkedSessionIDs(previous)
  const ids = [...new Set([...(reset ? existing : []), ...references.map((item) => item.sessionID)])].filter(
    (id) => reset || !existing.includes(id),
  )
  return [
    ...(reset ? [{ permission: "session_transcript", pattern: "*", action: "ask" as const }] : []),
    ...ids.map((pattern) => ({ permission: "session_transcript", pattern, action: "allow" as const })),
    ...references
      .filter((item) => {
        const action = previous.findLast(
          (rule) => rule.permission === PROJECT_READ_PERMISSION && rule.pattern === item.sessionID,
        )?.action
        return action !== (item.readFiles ? "allow" : "deny")
      })
      .map((item) => ({
        permission: PROJECT_READ_PERMISSION,
        pattern: item.sessionID,
        action: item.readFiles ? ("allow" as const) : ("deny" as const),
      })),
  ]
}
