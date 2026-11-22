export type Payload = {
  id: string
  type: string
  properties: any
}

const PART_DELTA = "message.part.delta"

function sameDelta(a: Payload, b: Payload) {
  const pa = a.properties
  const pb = b.properties
  return (
    pa.partID === pb.partID &&
    pa.messageID === pb.messageID &&
    pa.sessionID === pb.sessionID &&
    pa.field === pb.field &&
    typeof pa.delta === "string" &&
    typeof pb.delta === "string"
  )
}

// Coalesces adjacent message.part.delta payloads for the same part into one
// payload, so a per-token stream costs roughly one SSE frame per flush window
// instead of one frame (serialize + socket write) per token. Only immediately
// adjacent deltas for the same part and field are merged, so ordering with
// respect to every other event type is preserved.
export function mergePartDeltas<T>(
  events: Iterable<T>,
  unwrap: (item: T) => Payload,
  wrap: (item: T, payload: Payload) => T,
  related?: (a: T, b: T) => boolean,
): T[] {
  const out: T[] = []
  for (const item of events) {
    const cur = unwrap(item)
    const index = out.length - 1
    const prevItem = index >= 0 ? out[index] : undefined
    const prev = prevItem !== undefined ? unwrap(prevItem) : undefined
    if (
      prev !== undefined &&
      prev.type === PART_DELTA &&
      cur.type === PART_DELTA &&
      sameDelta(prev, cur) &&
      (related === undefined || related(prevItem as T, item))
    ) {
      out[index] = wrap(prevItem as T, {
        id: cur.id,
        type: cur.type,
        properties: { ...prev.properties, delta: prev.properties.delta + cur.properties.delta },
      })
      continue
    }
    out.push(item)
  }
  return out
}
