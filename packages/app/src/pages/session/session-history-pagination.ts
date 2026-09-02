export function historyPageResult(input: {
  loaded: number
  nextLoaded: number
  visibleBefore: number
  visibleAfter: number
  more: boolean
}) {
  if (input.visibleAfter > input.visibleBefore) return "renderable-growth" as const
  if (input.nextLoaded <= input.loaded) return "stalled" as const
  if (!input.more) return "complete" as const
  return "continue" as const
}
