/** Stable title marker for sessions written by scheduled tasks. */
export const SCHEDULED_SESSION_TITLE_PREFIX = "[scheduled]"

export function isScheduledSessionTitle(title: string): boolean {
  return title.startsWith(SCHEDULED_SESSION_TITLE_PREFIX)
}

/** Ensure a session title carries the scheduled marker (idempotent). */
export function markScheduledSessionTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return SCHEDULED_SESSION_TITLE_PREFIX
  if (isScheduledSessionTitle(trimmed)) return trimmed
  return `${SCHEDULED_SESSION_TITLE_PREFIX} ${trimmed}`
}

/** Display title without the internal scheduled marker. */
export function stripScheduledSessionTitle(title: string): string {
  if (!isScheduledSessionTitle(title)) return title
  const rest = title.slice(SCHEDULED_SESSION_TITLE_PREFIX.length).trimStart()
  return rest || title
}
