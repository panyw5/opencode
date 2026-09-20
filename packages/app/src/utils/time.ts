import { DateTime } from "luxon"

type TimeKey =
  | "common.time.justNow"
  | "common.time.minutesAgo.short"
  | "common.time.hoursAgo.short"
  | "common.time.daysAgo.short"

type Translate = (key: TimeKey, params?: Record<string, string | number>) => string

/** Format an epoch timestamp as the wall-clock value expected by datetime-local inputs. */
export function formatDateTimeLocal(
  value: number,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  if (!Number.isFinite(value)) return ""
  const result = DateTime.fromMillis(value).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm")
  console.debug("[scheduled-time] formatted local datetime", { input: value, timezone, output: result })
  return result
}

/** Parse a datetime-local wall-clock value in the selected timezone. */
export function parseDateTimeLocal(value: string, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone): number {
  const parsed = DateTime.fromISO(value, { zone: timezone })
  const result = parsed.isValid ? parsed.toMillis() : Number.NaN
  console.debug("[scheduled-time] parsed local datetime", {
    input: value,
    timezone,
    output: Number.isFinite(result) ? result : undefined,
  })
  return result
}

export function getRelativeTime(dateString: string, t: Translate): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return t("common.time.justNow")
  if (diffMinutes < 60) return t("common.time.minutesAgo.short", { count: diffMinutes })
  if (diffHours < 24) return t("common.time.hoursAgo.short", { count: diffHours })
  return t("common.time.daysAgo.short", { count: diffDays })
}
