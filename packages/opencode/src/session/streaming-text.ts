type Key = { sessionID: string; messageID: string; partID: string }
type Entry = Key & { flat: string; tail: string[]; length: number }

// Deltas are transient bus events. Snapshot readers must overlay them until
// the final part update is persisted, without writing SQLite for every token.
const entries = new Map<string, Entry>()

// Appends push into `tail`; joining is deferred to reads so per-token appends
// stay amortized O(1) instead of copying the whole accumulated string.
function text(entry: Entry) {
  if (entry.tail.length === 0) return entry.flat
  entry.flat += entry.tail.join("")
  entry.tail.length = 0
  return entry.flat
}

export function streamingText(key: Key) {
  const entry = entries.get(key.partID)
  if (entry?.sessionID === key.sessionID && entry.messageID === key.messageID) return text(entry)
}

// Cheap existence check for the per-delta hot path: callers that only need to
// know an entry exists must not pay for materializing the accumulated text.
export function hasStreamingText(key: Key) {
  const entry = entries.get(key.partID)
  return entry?.sessionID === key.sessionID && entry.messageID === key.messageID
}

export function appendStreamingText(key: Key, base: string, delta: string) {
  const entry = entries.get(key.partID)
  if (entry?.sessionID === key.sessionID && entry.messageID === key.messageID) {
    const offset = entry.length
    entry.tail.push(delta)
    entry.length += delta.length
    return offset
  }
  entries.set(key.partID, { ...key, flat: base, tail: [delta], length: base.length + delta.length })
  return base.length
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
