type Key = { sessionID: string; messageID: string; partID: string }
type Entry = Key & { text: string }

// Deltas are transient bus events. Snapshot readers must overlay them until
// the final part update is persisted, without writing SQLite for every token.
const entries = new Map<string, Entry>()

export function streamingText(key: Key) {
  const entry = entries.get(key.partID)
  if (entry?.sessionID === key.sessionID && entry.messageID === key.messageID) return entry.text
}

export function appendStreamingText(key: Key, base: string, delta: string) {
  const text = (streamingText(key) ?? base) + delta
  entries.set(key.partID, { ...key, text })
  return text.length - delta.length
}

export function withStreamingText<T extends { id: string; sessionID: string; messageID: string; type: string }>(
  part: T,
): T {
  if (part.type !== "text" && part.type !== "reasoning") return part
  const text = streamingText({ ...part, partID: part.id })
  return text === undefined ? part : { ...part, text }
}

export function clearStreamingText(key: { sessionID: string; messageID?: string; partID?: string }) {
  if (key.partID) {
    const entry = entries.get(key.partID)
    if (entry?.sessionID === key.sessionID) entries.delete(key.partID)
    return
  }
  for (const [id, entry] of entries) {
    if (entry.sessionID === key.sessionID && (!key.messageID || entry.messageID === key.messageID)) entries.delete(id)
  }
}
