export function pickIdlePrewarmRow<T extends { start: number; size: number }>(
  items: readonly T[],
  top: number,
  limit: number,
  eligible: (item: T) => boolean,
) {
  return items.findLast((item) => {
    const gap = top - item.start - item.size
    return gap >= 0 && gap <= limit && eligible(item)
  })
}

export function isLongMathText(text: string) {
  return text.length >= 1_200 && (text.includes("$$") || text.includes("\\[") || text.includes("\\begin{"))
}
