/** Settled navigation keeps positioning ownership until explicit takeover. */
export function timelineScrollOwner(input: { navigating: boolean; bottom: boolean; history: boolean }) {
  if (input.navigating) return "navigation"
  if (input.bottom) return "bottom"
  if (input.history) return "history"
  return "reading"
}

/** Use the same virtual-coordinate goal for first reveal and every height commit. */
export function timelineMessageScrollTop(input: {
  rowStart: number
  totalSize: number
  viewportHeight: number
  inset: number
}) {
  return Math.min(Math.max(0, input.rowStart - input.inset), Math.max(0, input.totalSize - input.viewportHeight))
}
