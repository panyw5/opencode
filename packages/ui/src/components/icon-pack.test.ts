import { describe, expect, test } from "bun:test"
import { iconUsesLucide, iconUsesPhosphor, iconUsesTabler } from "./icon"
import { lucideIcons } from "./lucide-icons"
import { phosphorIcons } from "./phosphor-icons"
import { tablerIcons } from "./tabler-icons"

const configNames = [
  "shopping-bag",
  "book",
  "providers",
  "robot",
  "mcp",
  "terminal",
  "speech-bubble",
  "review",
  "code",
  "chevron-left",
  "magnifying-glass",
  "trash",
]

describe("phosphor icon pack", () => {
  test("maps config and marketplace names to phosphor glyphs", () => {
    for (const name of configNames) {
      expect(iconUsesPhosphor(name)).toBe(true)
      expect(phosphorIcons[name]?.includes("<path")).toBe(true)
    }
  })

  test("keeps product marks on the hand-drawn set", () => {
    expect(iconUsesPhosphor("openclaw")).toBe(false)
    expect(iconUsesPhosphor("hermes")).toBe(false)
    expect(phosphorIcons.openclaw).toBeUndefined()
    expect(phosphorIcons.hermes).toBeUndefined()
  })

  test("is the default pack for mapped names", () => {
    expect(iconUsesPhosphor("shopping-bag")).toBe(true)
    expect(iconUsesPhosphor("shopping-bag", "legacy")).toBe(false)
    expect(iconUsesPhosphor("shopping-bag", "lucide")).toBe(false)
    expect(iconUsesPhosphor("shopping-bag", "tabler")).toBe(false)
  })
})

describe("tabler icon pack", () => {
  test("maps config and marketplace names to tabler glyphs", () => {
    for (const name of configNames) {
      expect(iconUsesTabler(name)).toBe(true)
      expect(tablerIcons[name]?.body.includes("<path")).toBe(true)
    }
  })

  test("keeps product marks on the hand-drawn set", () => {
    expect(iconUsesTabler("openclaw")).toBe(false)
    expect(iconUsesTabler("hermes")).toBe(false)
    expect(tablerIcons.openclaw).toBeUndefined()
    expect(tablerIcons.hermes).toBeUndefined()
  })

  test("is not the default pack", () => {
    expect(iconUsesTabler("shopping-bag", "legacy")).toBe(false)
    expect(iconUsesTabler("shopping-bag", "phosphor")).toBe(false)
  })
})

describe("lucide icon pack", () => {
  test("maps config and marketplace names to lucide glyphs", () => {
    for (const name of configNames) {
      expect(iconUsesLucide(name)).toBe(true)
      expect(/<(path|rect|circle|line|polyline)[\s>]/.test(lucideIcons[name] ?? "")).toBe(true)
    }
  })

  test("keeps product marks and brand logos on the hand-drawn set", () => {
    expect(iconUsesLucide("openclaw")).toBe(false)
    expect(iconUsesLucide("hermes")).toBe(false)
    expect(iconUsesLucide("github")).toBe(false)
    expect(iconUsesLucide("discord")).toBe(false)
    expect(lucideIcons.openclaw).toBeUndefined()
    expect(lucideIcons.hermes).toBeUndefined()
  })

  test("is not the default pack", () => {
    expect(iconUsesLucide("shopping-bag", "legacy")).toBe(false)
    expect(iconUsesLucide("shopping-bag", "phosphor")).toBe(false)
    expect(iconUsesLucide("shopping-bag", "tabler")).toBe(false)
  })
})
