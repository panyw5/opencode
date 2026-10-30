import type { SessionMessagePage } from "@/context/global-sync/session-messages"
import { compareMessages } from "@/utils/message-order"
import { commandInvocationFromParts } from "@/utils/prompt"
import { splitMathInitializationPrompt } from "@opencode-ai/ui/injected-prompt-model"

export type ShareMessage = { id: string; time?: { created?: number }; role: "user" | "assistant"; markdown: string }

export function safeAttachmentName(name?: string) {
  return (name?.split(/[\\/]/).pop() || "Attachment").replace(/[\[\]`*_<>\\\r\n]/g, "")
}

export function localShareMarkdown(text: string) {
  return text
    .split(/(```[^]*?```|~~~[^]*?~~~|`[^`\n]*`)/g)
    .map((block, index) =>
      index % 2
        ? block
        : block
            .replace(
              /!\[([^\]]*)\]\(\s*(?!data:image\/)(?:[^)]*)\)/gi,
              (_, name: string) => `[${safeAttachmentName(name)}]`,
            )
            .replace(/<img\b[^>]*>/gi, "[Image]")
            .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, (_, name: string) => `[${safeAttachmentName(name)}]`),
    )
    .join("")
}

export function shareMessages(pages: SessionMessagePage[], revertMessageID?: string): ShareMessage[] {
  const all = pages.flatMap((page) => page.session)
  const boundary = all.find((message) => message.id === revertMessageID)
  const revertedUsers = new Set(
    all
      .filter(
        (message) =>
          message.role === "user" &&
          revertMessageID &&
          compareMessages(message, boundary ?? { id: revertMessageID }) >= 0,
      )
      .map((message) => message.id),
  )
  const messages = new Map<string, ShareMessage>()
  for (const page of [...pages].reverse()) {
    const parts = new Map(page.part.map((item) => [item.id, item.part]))
    for (const message of page.session) {
      if (message.role !== "user" && message.role !== "assistant") continue
      if (message.role === "assistant" && revertedUsers.has(message.parentID)) continue
      if (revertMessageID && compareMessages(message, boundary ?? { id: revertMessageID }) >= 0) continue
      if (message.role === "assistant" && message.summary) continue
      const messageParts = parts.get(message.id) ?? []
      const invocation = message.role === "user" ? commandInvocationFromParts(messageParts) : undefined
      const markdown = messageParts
        .flatMap((part) => {
          if (part.type === "text" && !invocation && !part.synthetic && !part.ignored)
            return [localShareMarkdown(splitMathInitializationPrompt(part.text)?.problem ?? part.text)]
          if (part.type === "file") {
            const name = safeAttachmentName(part.filename)
            if (
              part.mime.startsWith("image/") &&
              /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(part.url)
            ) {
              return [`![${name}](${part.url})`]
            }
            return [`[${name}]`]
          }
          return []
        })
        .join("\n\n")
      const body = [invocation, markdown].filter(Boolean).join("\n\n")
      if (body.trim())
        messages.set(message.id, { id: message.id, time: message.time, role: message.role, markdown: body })
    }
  }
  return [...messages.values()].sort(compareMessages)
}

export async function loadShareMessages(
  page: (input: {
    directory: string
    sessionID: string
    limit: number
    before?: string
  }) => Promise<SessionMessagePage>,
  directory: string,
  sessionID: string,
  revertMessageID?: string,
) {
  const pages: SessionMessagePage[] = []
  const seen = new Set<string>()
  let before: string | undefined
  do {
    const result = await page({ directory, sessionID, limit: 200, before })
    pages.push(result)
    if (result.complete) break
    if (!result.cursor || seen.has(result.cursor)) throw new Error("Message history cursor did not advance")
    seen.add(result.cursor)
    before = result.cursor
  } while (before)
  return shareMessages(pages, revertMessageID)
}

export function visibleShareMessages(messages: ShareMessage[], role: string) {
  return messages.filter((item) => role === "all" || item.role === role)
}

export function selectVisibleShareMessages(selected: readonly string[], messages: ShareMessage[], role: string) {
  return [...new Set([...selected, ...visibleShareMessages(messages, role).map((item) => item.id)])]
}

export function toggleShareSelection(selected: readonly string[], id: string, checked: boolean) {
  return checked ? [...new Set([...selected, id])] : selected.filter((item) => item !== id)
}

export async function runShareExport(
  selected: readonly string[],
  save: () => Promise<{ cancelled: boolean; files: number }>,
) {
  if (!selected.length) return { status: "empty" as const }
  try {
    const result = await save()
    return { status: result.cancelled ? ("cancelled" as const) : ("saved" as const), files: result.files }
  } catch (error) {
    return { status: "failed" as const, error: String(error) }
  }
}

export function shareMarkdown(
  messages: ShareMessage[],
  selected: readonly string[],
  title: string,
  labels = {
    user: "User",
    assistant: "Assistant",
    omitted: "Messages omitted",
  },
) {
  const ids = new Set(selected)
  const blocks: string[] = [`# ${title.replace(/[\r\n]/g, " ")}`]
  let omitted = false
  let previousRole: ShareMessage["role"] | undefined
  for (const message of messages) {
    if (!ids.has(message.id)) {
      omitted = true
      continue
    }
    if (previousRole && previousRole !== message.role) blocks.push("---")
    if (omitted) blocks.push(`*… ${labels.omitted} …*`)
    blocks.push(`## ${labels[message.role]}\n\n${message.markdown}`)
    omitted = false
    previousRole = message.role
  }
  if (omitted && selected.length) blocks.push(`*… ${labels.omitted} …*`)
  return blocks.join("\n\n") + "\n"
}
