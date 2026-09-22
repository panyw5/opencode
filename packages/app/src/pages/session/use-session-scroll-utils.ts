export const SESSION_SCROLL_BOTTOM_THRESHOLD = 16

export function physicalScrollGap(input: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  return Math.max(0, input.scrollHeight - input.clientHeight - input.scrollTop)
}

export function atPhysicalBottom(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  threshold?: number
}) {
  return physicalScrollGap(input) <= (input.threshold ?? SESSION_SCROLL_BOTTOM_THRESHOLD)
}

export function targetTop(input: { itemTop: number; rootTop: number; scrollTop: number; inset: number }) {
  return Math.max(0, input.itemTop - input.rootTop + input.scrollTop - input.inset)
}

export function reachableTargetTop(
  input: Parameters<typeof targetTop>[0] & { scrollHeight: number; clientHeight: number },
) {
  const max = Math.max(0, input.scrollHeight - input.clientHeight)
  return Math.min(targetTop(input), max)
}
