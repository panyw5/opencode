export const UI_LOCALE_HEADER = "x-opencode-locale"

export const UI_LOCALES = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "bs",
  "ar",
  "no",
  "br",
  "th",
  "tr",
] as const

export type UILocale = (typeof UI_LOCALES)[number]

export function parseUILocale(value: unknown): UILocale | undefined {
  return typeof value === "string" && UI_LOCALES.includes(value as UILocale) ? (value as UILocale) : undefined
}
