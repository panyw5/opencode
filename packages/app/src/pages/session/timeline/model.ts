import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2"
import type { Accessor } from "solid-js"
import { compareMessages, resolveMessage, sortMessages } from "@/utils/message-order"

export function assistantCopySummary(messages: AssistantMessage[], parts: (messageID: string) => Part[]) {
  let partID: string | undefined
  const text: string[] = []

  for (const message of messages) {
    for (const part of parts(message.id)) {
      if (part.type !== "text" || !part.text?.trim()) continue
      partID = part.id
      text.push(part.text)
    }
  }

  return { partID, text: text.join("\n\n") }
}

export function selectUserMessages(messages: Message[]) {
  return sortMessages(messages.filter((message): message is UserMessage => message.role === "user"))
}

export function selectVisibleUserMessages(messages: UserMessage[], revertMessageID?: string) {
  if (!revertMessageID) return messages
  const boundary = resolveMessage(messages, revertMessageID)
  if (!boundary) return messages.filter((message) => message.id < revertMessageID)
  return messages.filter((message) => compareMessages(message, boundary) < 0)
}

export async function loadOlderTimeline(input: {
  sessionID: Accessor<string | undefined>
  loaded: Accessor<number>
  visible: Accessor<number>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: (sessionID: string) => Promise<void>
  before?: () => void
  after?: (done: boolean) => void
}) {
  const id = input.sessionID()
  if (!id || !input.more() || input.loading()) return

  // A history page may contain only assistant messages or user turns hidden by a revert boundary.
  const beforeVisible = input.visible()
  let loaded = input.loaded()
  input.before?.()
  while (true) {
    await input.loadMore(id).catch((error) => {
      if (input.sessionID() === id) input.after?.(true)
      throw error
    })
    if (input.sessionID() !== id) return

    const nextLoaded = input.loaded()
    const growth = input.visible() - beforeVisible
    const raw = nextLoaded - loaded
    loaded = nextLoaded
    const done = growth > 0 || raw <= 0 || !input.more()
    input.after?.(done)
    if (done) return
  }
}
