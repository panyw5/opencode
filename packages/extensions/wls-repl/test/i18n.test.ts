import { expect, test } from "bun:test"
import { messages } from "../src/i18n"

test("all application languages provide complete localized controls", () => {
  const locales = [
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
    "ar",
    "no",
    "br",
    "th",
    "bs",
    "tr",
  ]
  for (const locale of locales) {
    const value = messages(locale)
    expect(Object.keys(value)).toEqual(Object.keys(messages("en")))
    expect(value.pausedLine).toContain("{line}")
    for (const text of Object.values(value)) expect(text.length).toBeGreaterThan(0)
    if (locale !== "en") expect(value.run).not.toBe("Run")
    expect(value.abort).not.toBe(value.stop)
  }
  expect(messages("pt-BR")).toBe(messages("br"))
  expect(messages("nb-NO")).toBe(messages("no"))
  expect(messages("nn")).toBe(messages("no"))
  expect(messages("de-AT").run).toBe("Ausführen")
  expect(messages("zh-Hant-TW")).toBe(messages("zht"))
  expect(messages("zh-MO")).toBe(messages("zht"))
  for (const value of ["", "unknown", "__proto__", "constructor"]) expect(messages(value)).toBe(messages("en"))
})

test("WLS controls use the application locale with an English fallback", () => {
  expect(messages("en-US").run).toBe("Run")
  expect(messages("zh").run).toBe("运行")
  expect(messages("zh-CN").input).toBe("在内核中计算表达式")
  for (const tag of ["zht", "zh-TW", "zh-Hant", "zh_HK"]) expect(messages(tag).run).toBe("執行")
  expect(messages("ja-JP").run).toBe("実行")
  expect(messages("unknown").run).toBe("Run")
  for (const tag of ["en", "zh", "zht", "ja"]) {
    expect(Object.keys(messages(tag))).toEqual(Object.keys(messages("en")))
    expect(messages(tag).pausedLine).toContain("{line}")
  }
})
