const railWidths = [48, 38, 30, 24] as const

export function userMessageRailMarkWidth(index: number, hovered: number | undefined) {
  if (hovered === undefined) return 20
  return railWidths[Math.abs(index - hovered)] ?? 20
}

export function userMessageRailHeight(count: number) {
  return Math.min(520, Math.max(0, count) * 20)
}
