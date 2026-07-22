const FALLBACK_TIMEZONES = [
  "UTC",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/New_York",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Kolkata",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Moscow",
  "Europe/Paris",
  "Pacific/Auckland",
] as const

/** IANA time zone identifiers available in the runtime. */
export function listTimeZones(): string[] {
  try {
    if (typeof Intl !== "undefined" && "supportedValuesOf" in Intl) {
      return [...(Intl as typeof Intl & { supportedValuesOf(key: "timeZone"): string[] }).supportedValuesOf("timeZone")]
    }
  } catch {
    // fall through
  }
  return [...FALLBACK_TIMEZONES]
}

/** Time zone options for a select, ensuring the current value remains choosable. */
export function timeZoneOptions(current?: string): string[] {
  const list = listTimeZones()
  const value = current?.trim()
  if (value && !list.includes(value)) return [value, ...list]
  return list
}

export function timeZoneGroup(zone: string): string {
  const slash = zone.indexOf("/")
  if (slash <= 0) return zone
  return zone.slice(0, slash)
}
