import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as tr } from "./tr"

const locales = [ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht]
const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const
const searchIndexKeys = [
  "settings.general.section.searchIndex",
  "settings.general.searchIndex.title",
  "settings.general.searchIndex.description",
  "settings.general.searchIndex.status.loading",
  "settings.general.searchIndex.status.disabled",
  "settings.general.searchIndex.status.unavailable",
  "settings.general.searchIndex.status.complete",
  "settings.general.searchIndex.status.buildingUnknown",
  "settings.general.searchIndex.status.building",
  "settings.general.searchIndex.progress.label",
  "settings.general.searchIndex.action.enable",
  "settings.general.searchIndex.action.disable",
  "settings.general.searchIndex.action.rebuild",
] as const

describe("i18n parity", () => {
  test("non-English locales translate targeted unseen session keys", () => {
    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })

  test("non-English locales translate global search settings", () => {
    for (const locale of locales) {
      for (const key of searchIndexKeys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })
})
