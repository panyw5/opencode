import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

export function removeQuickRequest<T extends { id: string }>(items: T[] | undefined, id: string): T[] {
  return (items ?? []).filter((item) => item.id !== id)
}

export function patchAgentQuestionDeny(input: unknown) {
  const agent = input && typeof input === "object" && !Array.isArray(input) ? input : {}
  const permission =
    (agent as Record<string, unknown>).permission &&
    typeof (agent as Record<string, unknown>).permission === "object" &&
    !Array.isArray((agent as Record<string, unknown>).permission)
      ? (agent as Record<string, unknown>).permission
      : {}
  const nextPermission = { ...(permission as Record<string, unknown>) }
  if (nextPermission.question !== undefined && nextPermission.question !== "deny") return input
  nextPermission.question = "allow"
  return {
    ...(agent as Record<string, unknown>),
    permission: nextPermission,
  }
}

export function quickQuestionAnswers(
  questions: Array<{ multiple?: boolean; custom?: boolean }>,
  selected: Record<number, string[]>,
  custom: Record<number, string>,
) {
  return questions.map((question, index) => {
    const values = selected[index] ?? []
    const text = question.custom === false ? "" : (custom[index] ?? "").trim()
    if (!text) return values
    return question.multiple ? [...values.filter((item) => item !== text), text] : [text]
  })
}

export function quickRequestNotFound(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false
  seen.add(error)
  const value = error as Record<string, unknown>
  if (value.status === 404 || value.statusCode === 404) return true
  if (["QuestionNotFoundError", "PermissionNotFoundError"].includes(String(value.name))) return true
  return [value.cause, value.body, value.data].some((item) => quickRequestNotFound(item, seen))
}

export function render(parts: Part[] | undefined) {
  if (!parts?.length) return ""
  return parts
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "reasoning") return part.text
      if (part.type === "tool") return `[tool] ${part.tool}`
      if (part.type === "file") return `[file] ${part.filename || part.url}`
      if (part.type === "agent") return `@${part.name}`
      return ""
    })
    .filter(Boolean)
    .join("\n")
    .trim()
}

export function mergeMessages(a: Message[] | undefined, b: Message[]) {
  return Array.from(
    [...(a ?? []), ...b].reduce((map, item) => map.set(item.id, item), new Map<string, Message>()).values(),
  ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function context(dir: string, id: string, session: Session | undefined, count: number) {
  if (!dir || !id) return ""
  return [
    "<current-opencode-session>",
    `directory: ${dir}`,
    `session_id: ${id}`,
    `title: ${session?.title || "Untitled"}`,
    `message_count: ${count}`,
    "</current-opencode-session>",
  ].join("\n")
}

export function prompt(text: string, extra: string, on: boolean) {
  return [on ? extra : "", text].filter(Boolean).join("\n\n")
}

export function isSessionNotFoundError(err: unknown, seen = new Set<unknown>()): boolean {
  if (!err || typeof err !== "object") return false
  if (seen.has(err)) return false
  seen.add(err)

  const obj = err as Record<string, unknown>
  if (obj.name === "NotFoundError" || obj.name === "SessionNotFoundError") return true

  const data = obj.data
  if (data && typeof data === "object" && isSessionNotFoundError(data, seen)) return true

  const body = obj.body
  if (body && typeof body === "object" && isSessionNotFoundError(body, seen)) return true

  const cause = obj.cause
  if (cause && typeof cause === "object" && isSessionNotFoundError(cause, seen)) return true

  return false
}
