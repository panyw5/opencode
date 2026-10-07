import { compareMessages, resolveMessage, type OrderedMessage } from "@/utils/message-order"

export type SessionRevertBoundary = {
  sessionKey: string
  message: OrderedMessage
}

export function resolveSessionRevertBoundary(input: {
  sessionKey: string
  messageID?: string
  messages: readonly OrderedMessage[]
  indexed?: readonly OrderedMessage[]
  previous?: SessionRevertBoundary
}): SessionRevertBoundary | undefined {
  if (!input.messageID) return
  const previous = input.previous
  const cached =
    previous?.sessionKey === input.sessionKey && previous.message.id === input.messageID ? previous : undefined
  const message =
    resolveMessage(input.messages, input.messageID) ?? resolveMessage(input.indexed ?? [], input.messageID)
  const created = message?.time?.created ?? cached?.message.time?.created
  if (cached && cached.message.time?.created === created) return cached
  // Cleanup removes the boundary before clearing session.revert. Keep its
  // timestamp so mixed/synthetic IDs cannot resurrect the remaining suffix.
  return {
    sessionKey: input.sessionKey,
    message: { id: input.messageID, ...(created === undefined ? {} : { time: { created } }) },
  }
}

export function visibleBeforeRevert<T extends OrderedMessage>(
  messages: T[],
  boundary: SessionRevertBoundary | undefined,
  pending: (id: string) => boolean = () => false,
) {
  if (!boundary) return messages
  return messages.filter((message) => pending(message.id) || compareMessages(message, boundary.message) < 0)
}
