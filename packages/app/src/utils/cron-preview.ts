import { Cron } from "croner"
import cronstrue from "cronstrue/i18n"

/** Match server-side normalize: five-field expressions get a leading seconds field. */
export function normalizeCronExpression(expression: string): string {
  const value = expression.trim()
  if (!value) return ""
  const count = value.split(/\s+/).filter(Boolean).length
  if (count === 5) return `0 ${value}`
  return value
}

/** Expression string for humanization / croner (prefer five-field for cronstrue). */
function expressionForDescribe(expression: string): string {
  const value = expression.trim()
  if (!value) return ""
  const parts = value.split(/\s+/).filter(Boolean)
  // cronstrue handles 5-field standard cron best; strip leading seconds when * or 0.
  if (parts.length === 6 && (parts[0] === "0" || parts[0] === "*")) {
    return parts.slice(1).join(" ")
  }
  return value
}

/** Map app locale codes to cronstrue locale ids. */
export function cronstrueLocale(locale?: string): string {
  switch (locale) {
    case "zh":
      return "zh_CN"
    case "zht":
      return "zh_TW"
    case "ja":
      return "ja"
    case "ko":
      return "ko"
    case "de":
      return "de"
    case "es":
      return "es"
    case "fr":
      return "fr"
    case "ru":
      return "ru"
    case "ar":
      return "ar"
    case "pl":
      return "pl"
    case "tr":
      return "tr"
    case "da":
      return "da"
    case "no":
      return "nb"
    case "br":
      return "pt_BR"
    case "th":
      return "th"
    case "uk":
      return "uk"
    case "bs":
      return "en"
    default:
      return "en"
  }
}

/** Next fire time for a cron expression, or undefined if invalid / empty. */
export function nextCronRunAt(expression: string, timezone?: string, now = Date.now()): number | undefined {
  const normalized = normalizeCronExpression(expression)
  if (!normalized) return
  try {
    const cron = new Cron(normalized, {
      paused: true,
      timezone: timezone?.trim() || undefined,
    })
    try {
      return cron.nextRun(new Date(now))?.getTime()
    } finally {
      cron.stop()
    }
  } catch {
    return
  }
}

/**
 * Human-readable meaning of a cron expression (e.g. "0 9 * * 1-5" →
 * "在09:00, 星期一至星期五"). Returns "NA" when empty or unparseable.
 */
export function describeCronExpression(expression: string, locale?: string, timezone?: string): string {
  const value = expressionForDescribe(expression)
  if (!value) return "NA"

  // Validate with the same engine the scheduler uses (incl. timezone).
  if (nextCronRunAt(expression, timezone) === undefined) return "NA"

  try {
    return cronstrue.toString(value, {
      locale: cronstrueLocale(locale),
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    })
  } catch {
    return "NA"
  }
}

/** @deprecated Prefer describeCronExpression for UI preview. */
export function formatCronNextRun(expression: string, timezone?: string, now = Date.now()): string {
  const at = nextCronRunAt(expression, timezone, now)
  return at ? new Date(at).toLocaleString() : "NA"
}
