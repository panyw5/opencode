import type { Detail } from "./schema"

/** Format mounted project-task detail for LLM system prompt injection. */
export function formatProjectTaskSystemContext(detail: Detail): string {
  const lines: string[] = [
    "<project-task-context>",
    "The user has mounted a project-level task on this session. Use this as working context when relevant.",
    `Task ID: ${detail.id}`,
    `Title: ${detail.title}`,
    `Status: ${detail.status}`,
  ]
  if (detail.priority) lines.push(`Priority: ${detail.priority}`)
  lines.push(
    `Todo progress (all linked sessions): ${detail.progress.completed}/${detail.progress.total} completed` +
      (detail.progress.inProgress ? `, ${detail.progress.inProgress} in progress` : ""),
  )
  if (detail.description.trim()) {
    lines.push("", "Description:", detail.description.trim())
  }
  lines.push("", `Linked sessions: ${detail.sessionCount}`)
  for (const session of detail.sessions.slice(0, 12)) {
    lines.push(
      `- ${session.title} (${session.sessionID}): ${session.progress.completed}/${session.progress.total} todos`,
    )
    const open = session.todos.filter((t) => t.status === "pending" || t.status === "in_progress").slice(0, 8)
    for (const todo of open) {
      lines.push(`    · [${todo.status}] ${todo.content}`)
    }
  }
  if (detail.sessions.length > 12) {
    lines.push(`… and ${detail.sessions.length - 12} more sessions`)
  }
  lines.push("</project-task-context>")
  return lines.join("\n")
}
