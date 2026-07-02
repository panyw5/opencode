export function resolveAtMenuLeft(input: {
  anchorLeft: number
  boxWidth: number
  menuWidth: number
  margin?: number
}) {
  const margin = input.margin ?? 8
  const maxLeft = Math.max(margin, input.boxWidth - input.menuWidth - margin)
  const right = input.anchorLeft

  if (right + input.menuWidth <= input.boxWidth - margin) {
    return Math.max(margin, Math.min(right, maxLeft))
  }

  const left = input.anchorLeft - input.menuWidth
  return Math.max(margin, Math.min(left, maxLeft))
}
