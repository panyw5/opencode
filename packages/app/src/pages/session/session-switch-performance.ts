export function shouldRefreshStaleSession(input: {
  wasStale: boolean
  refreshedAt?: number
  now: number
  ttl: number
}) {
  if (!input.wasStale) return false
  if (input.refreshedAt === undefined) return true
  return input.now - input.refreshedAt > input.ttl
}

export function shouldFinishInitialScroll(input: { stableFrames: number; now: number; deadline: number }) {
  return input.stableFrames >= 3 || input.now >= input.deadline
}
