const railWidths = [48, 38, 30, 24] as const
export const USER_MESSAGE_RAIL_PREVIEW_LIMIT = 240
export const USER_MESSAGE_RAIL_ACTIVE_WIDTH = 30

export function userMessageRailMarkWidth(index: number, hovered: number | undefined, active?: number) {
  if (hovered !== undefined) return railWidths[Math.abs(index - hovered)] ?? 20
  if (active !== undefined && index === active) return USER_MESSAGE_RAIL_ACTIVE_WIDTH
  return 20
}

export function userMessageRailHeight(count: number) {
  return Math.min(520, Math.max(0, count) * 20)
}

export function userMessageRailPreview(text: string, limit = USER_MESSAGE_RAIL_PREVIEW_LIMIT) {
  if (text.length <= limit) return text
  if (limit <= 3) return ".".repeat(Math.max(0, limit))
  return `${text.slice(0, limit - 3).trimEnd()}...`
}
