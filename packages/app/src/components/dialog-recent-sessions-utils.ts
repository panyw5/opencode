import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"

export const RECENT_SESSION_LIMIT = 20

export function latestUserMessageText(items: Array<{ info: Message; parts: Part[] }>) {
  const users = items
    .filter((item) => item.info.role === "user")
    .sort((a, b) => b.info.time.created - a.info.time.created)
  for (const user of users) {
    const text = user.parts
      .flatMap((part) => (part.type === "text" && part.text && !part.synthetic && !part.ignored ? [part.text] : []))
      .join("\n")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text.slice(0, 500)
  }
}

export function mergeRecentSessions<T extends Session>(groups: T[][]) {
  const unique = new Map<string, T>()
  for (const group of groups) {
    for (const session of group) {
      if (session.parentID || session.time.archived) continue
      unique.set(session.id, session)
    }
  }

  return [...unique.values()]
    .sort((a, b) => {
      const aUpdated = a.time.updated ?? a.time.created
      const bUpdated = b.time.updated ?? b.time.created
      if (aUpdated !== bUpdated) return bUpdated - aUpdated
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .slice(0, RECENT_SESSION_LIMIT)
}
