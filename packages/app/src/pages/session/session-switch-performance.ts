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

/** Secondary session requests must not compete with the first tab paint on Windows Electron. */
export function sessionBackgroundDelay(userAgent: string, fallback = 250) {
  return userAgent.includes("Windows") && userAgent.includes("Electron") ? 1_000 : fallback
}
