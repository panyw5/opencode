import { expect, test } from "bun:test"
import { translator, resolveTemplate } from "@solid-primitives/i18n"
import { dict as en } from "../i18n/en"
import { dict as zh } from "../i18n/zh"

test("remote settings substitute timestamps, countdowns and device names in both languages", () => {
  for (const dict of [en, zh]) {
    const t = translator(() => dict, resolveTemplate)
    expect(t("settings.remote.deviceSeen", { date: "2026-10-19 15:00:01" })).toContain("2026-10-19 15:00:01")
    expect(t("settings.remote.devicePaired", { date: "2026-10-19 14:00:01" })).toContain("2026-10-19 14:00:01")
    expect(t("settings.remote.pairExpires", { seconds: 123 })).toContain("123")
    expect(t("settings.remote.revokeConfirm", { name: "Phone A" })).toContain("Phone A")
  }
})
