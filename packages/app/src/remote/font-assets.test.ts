import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { verifyRemoteFonts } from "./font-build"
import manifest from "../../../ui/src/assets/fonts-remote/manifest.json"

test("checked-in remote fonts match their sources and retain substantial savings", () => {
  expect(() => verifyRemoteFonts()).not.toThrow()
  const records = Object.values(manifest)
  expect(records.length).toBeGreaterThanOrEqual(20)
  expect(records.every((record) => record.sharedGlyphs > 10_000)).toBe(true)
  expect(records.reduce((sum, record) => sum + record.after, 0)).toBeLessThan(2_000_000)
  expect(records.reduce((sum, record) => sum + record.before - record.after, 0)).toBeGreaterThan(20_000_000)
})

test("standalone Fira theme faces and the shared IBM glyph fallback are not subset", () => {
  expect(Object.keys(manifest).some((name) => /^(BlexMono|FiraCode)/.test(name))).toBe(false)
  const source = readFileSync(new URL("../../../ui/src/font-loader.ts", import.meta.url), "utf8")
  for (const id of [
    "jetbrains-mono",
    "fira-code",
    "cascadia-code",
    "hack",
    "source-code-pro",
    "inconsolata",
    "roboto-mono",
    "ubuntu-mono",
    "intel-one-mono",
    "meslo-lgs",
    "iosevka",
    "geist-mono",
  ])
    expect(source).toContain(`id: "${id}"`)
})
