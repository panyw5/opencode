export type AgentNameIssue = "empty" | "reserved" | "slash"

/** Mirror the CLI `opencode agent create` targets: <config>/agents/<name>.md and <project>/.opencode/agents/<name>.md. */
export function agentFilePath(root: string, title: string) {
  const name = title.trim() || "agent"
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/"
  return [root.replace(/[\\/]+$/, ""), `${name}.md`].join(sep)
}

export function agentNameIssue(value: string): AgentNameIssue | undefined {
  const name = value.trim()
  if (!name) return "empty"
  if (name === "." || name === "..") return "reserved"
  if (/[/\\]/.test(name)) return "slash"
  return undefined
}

function yaml(value: string) {
  return JSON.stringify(value.trim())
}

export function agentTemplate(title: string) {
  const name = title.trim()
  return [
    "---",
    `description: ${yaml("Describe what this agent does.")}`,
    "mode: subagent",
    "---",
    "",
    name ? `# ${name}` : "# New Agent",
    "",
    "Add the system prompt and behavior instructions for this agent here.",
    "",
  ].join("\n")
}
