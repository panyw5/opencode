const railWidths = [48, 38, 30, 24] as const
export const USER_MESSAGE_RAIL_PREVIEW_LIMIT = 240
export const USER_MESSAGE_RAIL_ACTIVE_WIDTH = 30
// The timeline keeps this much inset between the panel edge and message text
// while the rail is visible, so marks can reach into the padding without ever
// touching the text.
export const USER_MESSAGE_RAIL_TEXT_INSET = 34
const railMarkStart = 12
const railMarkMinWidth = 16
const railMarkClearance = 6
const rowPadding = 20

export function userMessageRailMarkWidth(
  index: number,
  hovered: number | undefined,
  active?: number,
  space = Number.POSITIVE_INFINITY,
) {
  let base = 20
  if (hovered !== undefined) base = railWidths[Math.abs(index - hovered)] ?? 20
  else if (active !== undefined && index === active) base = USER_MESSAGE_RAIL_ACTIVE_WIDTH
  const cap = Math.max(
    space + userMessageRailPad(space) + rowPadding - railMarkStart - railMarkClearance,
    railMarkMinWidth,
  )
  return Math.min(base, cap)
}

// Extra left padding the timeline adds (on top of the rows' own padding) so
// message text stays clear of the rail for a given gap between the panel edge
// and the content column.
export function userMessageRailPad(space: number) {
  return Math.max(0, USER_MESSAGE_RAIL_TEXT_INSET - rowPadding - space)
}

export function userMessageRailHeight(count: number) {
  return Math.min(520, Math.max(0, count) * 20)
}

export function userMessageRailPreview(text: string, limit = USER_MESSAGE_RAIL_PREVIEW_LIMIT) {
  if (text.length <= limit) return text
  if (limit <= 3) return ".".repeat(Math.max(0, limit))
  return `${text.slice(0, limit - 3).trimEnd()}...`
}
