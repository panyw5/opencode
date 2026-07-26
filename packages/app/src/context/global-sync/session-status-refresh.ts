import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

export const PROJECT_SESSION_STATUS_REFRESH_INTERVAL = 8_000

export function authoritativeSessionStatusMap(
  data: Record<string, SessionStatus> | null | undefined,
): Record<string, SessionStatus> {
  if (!data || typeof data !== "object") return {}
  return { ...data }
}

export function shouldRefreshProjectSessionStatus(active: boolean) {
  return active
}
