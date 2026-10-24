import { expect, test } from "bun:test"

const locales = [
  "ar",
  "br",
  "bs",
  "da",
  "de",
  "en",
  "es",
  "fr",
  "ja",
  "ko",
  "no",
  "pl",
  "ru",
  "th",
  "tr",
  "uk",
  "zh",
  "zht",
]

for (const locale of locales) {
  test(`GPT-Pro result actions have translations in ${locale}`, async () => {
    const { dict } = await import(`../i18n/${locale}.ts`)
    for (const key of ["openOriginal", "resultOpening", "resultMaximize", "resultRestore"]) {
      const value = dict[`ui.tool.gptPro.${key}`]
      expect(typeof value).toBe("string")
      expect(value.length).toBeGreaterThan(0)
    }
  })
}
