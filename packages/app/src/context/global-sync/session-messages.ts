import { Binary } from "@opencode-ai/core/util/binary"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { reconcile } from "solid-js/store"

export const SESSION_MESSAGE_SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

export type SessionMessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

export type SessionOptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

export type SessionOptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

export type SessionOptimisticItem = {
  message: Message
  parts: Part[]
}

export const compareSessionItemID = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function sortSessionParts(parts: Part[]) {
  return parts.filter((part) => !!part?.id).sort((a, b) => compareSessionItemID(a.id, b.id))
}

export function mergeSessionItems<T extends { id: string }>(a: readonly T[], b: readonly T[]) {
  const map = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) map.set(item.id, item)
  return [...map.values()].sort((x, y) => compareSessionItemID(x.id, y.id))
}

export function mergeFetchedSessionParts(fetched: Part[], cached: Part[] | undefined) {
  if (!cached?.length) return fetched
  const current = new Map(cached.map((part) => [part.id, part] as const))
  return fetched.map((part) => {
    const existing = current.get(part.id)
    if (existing?.type !== "text" || part.type !== "text") return part
    const cachedText = existing.text ?? ""
    const fetchedText = part.text ?? ""
    if (cachedText.length <= fetchedText.length || !cachedText.startsWith(fetchedText)) return part
    console.warn(
      `[session-messages] kept streaming text msg=${part.messageID} part=${part.id} cached=${cachedText.length} snapshot=${fetchedText.length}`,
    )
    return existing
  })
}

export function reconcileFetchedSessionParts(parts: Part[]) {
  return reconcile(parts, { key: "id", merge: true })
}

export function mergeOptimisticSessionPage(page: SessionMessagePage, items: SessionOptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortSessionParts(item.part)]))
  const confirmed: string[] = []
  for (const item of items) {
    const result = Binary.search(session, item.message.id, (message) => message.id)
    // The backend can replace attachment parts while resolving a prompt.
    // A persisted message ID confirms delivery, not identical input part IDs.
    if (result.found) {
      confirmed.push(item.message.id)
      continue
    }
    session.splice(result.index, 0, item.message)
    part.set(item.message.id, sortSessionParts(item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()]
      .sort((a, b) => compareSessionItemID(a[0], b[0]))
      .map(([id, value]) => ({ id, part: value })),
    confirmed,
  }
}
