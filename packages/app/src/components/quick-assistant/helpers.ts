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

export type SessionContextMessage = {
  role: "user" | "assistant"
  text: string
}

type SessionContextPage = {
  items: Array<{ info: Message; parts: Part[] }>
  cursor?: string
}

export async function collectSessionContext(loadPage: (before?: string) => Promise<SessionContextPage>, maxPages = 10) {
  const messages = new Map<string, { info: Message; parts: Part[] }>()
  const cursors = new Set<string>()
  let before: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const result = await loadPage(before)
    for (const item of result.items) messages.set(item.info.id, item)
    if (!result.cursor) {
      return {
        items: [...messages.values()].sort((a, b) => a.info.id.localeCompare(b.info.id)),
        complete: true,
        pages: page + 1,
      }
    }
    if (result.cursor === before || cursors.has(result.cursor))
      throw new Error("Session messages pagination did not advance")
    cursors.add(result.cursor)
    before = result.cursor
  }
  return {
    items: [...messages.values()].sort((a, b) => a.info.id.localeCompare(b.info.id)),
    complete: false,
    pages: maxPages,
  }
}

const FULL_CONTEXT_TOTAL_CHARS = 20_000
const FULL_CONTEXT_USER_CHARS = 1_500
const FULL_CONTEXT_ASSISTANT_CHARS = 5_000

export function fullSessionContextMessages(items: Array<{ info: Message; parts: Part[] }>) {
  const candidates = items
    .map((item) => ({
      role: item.info.role,
      text: item.parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic)
        .map((part) => part.text)
        .join("\n")
        .trim(),
    }))
    .filter((message): message is SessionContextMessage => !!message.text)

  const clip = (message: SessionContextMessage, limit: number) => {
    if (message.text.length <= limit) return message
    if (message.role === "user") return { ...message, text: `${message.text.slice(0, limit - 3)}...` }
    const head = Math.ceil((limit - 5) * 0.6)
    return { ...message, text: `${message.text.slice(0, head)}\n...\n${message.text.slice(-(limit - head - 5))}` }
  }

  const firstUser = candidates.findIndex((message) => message.role === "user")
  const first = firstUser === -1 ? undefined : clip(candidates[firstUser], FULL_CONTEXT_USER_CHARS)
  let remaining = FULL_CONTEXT_TOTAL_CHARS - (first?.text.length ?? 0)
  const result: SessionContextMessage[] = []
  for (let index = candidates.length - 1; index >= 0 && remaining >= 10; index--) {
    if (index === firstUser) continue
    const message = candidates[index]
    const clipped = clip(
      message,
      Math.min(message.role === "user" ? FULL_CONTEXT_USER_CHARS : FULL_CONTEXT_ASSISTANT_CHARS, remaining),
    )
    remaining -= clipped.text.length
    result.unshift(clipped)
  }
  return first ? [first, ...result] : result
}

export function context(
  dir: string,
  id: string,
  session: Session | undefined,
  count: number,
  options?: {
    messages?: SessionContextMessage[]
    complete?: boolean
  },
) {
  if (!dir || !id) return ""
  const recent = options?.messages ?? []
  const metadata = [
    "<current-opencode-session>",
    `directory: ${dir}`,
    `session_id: ${id}`,
    `title: ${session?.title || "Untitled"}`,
    `message_count: ${count}`,
    `history_scope: ${options?.complete === false ? "partial" : "complete"}`,
    `text_scope: ${recent.length} bounded excerpts`,
    "snapshot_source: OpenCode app",
    "snapshot_note: The messages below were attached by the app. Do not try to read this session through a localhost URL or SQLite.",
  ]
  if (recent.length > 0) {
    metadata.push(
      "<session-messages>",
      ...recent.flatMap((message) => [`<message role=\"${message.role}\">`, message.text, "</message>"]),
      "</session-messages>",
    )
  }
  return [...metadata, "</current-opencode-session>"].join("\n")
}

export function prompt(text: string, extra: string, on: boolean) {
  return [on ? extra : "", text].filter(Boolean).join("\n\n")
}

export function splitInjectedSessionContext(text: string) {
  const start = "<current-opencode-session>\ndirectory: "
  const end = "\n</current-opencode-session>\n\n"
  if (!text.startsWith(start)) return { message: text }
  const index = text.indexOf(end)
  if (index === -1) return { message: text }
  return {
    context: text.slice(0, index + end.length - 2),
    message: text.slice(index + end.length),
  }
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
