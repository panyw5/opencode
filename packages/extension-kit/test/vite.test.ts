import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { build } from "vite"
import extensionKit from "../vite.js"
import { extensionScopeSelector, scopeExtensionID, scopeSelector } from "../scope.js"

const ID = "example.scope-fixture"
const SCOPE = `[data-extension="${ID}"]`

describe("extension scope selector", () => {
  test("builds an attribute selector from the extension id", () => {
    expect(extensionScopeSelector("example.hello-viewer")).toBe('[data-extension="example.hello-viewer"]')
  })

  test("rejects ids that would inject into the attribute selector", () => {
    expect(() => extensionScopeSelector("no dot")).toThrow("valid extension id")
    expect(() => extensionScopeSelector('x"')).toThrow()
    expect(() => extensionScopeSelector(undefined as unknown as string)).toThrow()
  })
})

describe("extension scope selector rewrite", () => {
  test("prefixes regular selectors as descendants of the mount", () => {
    expect(scopeSelector(".panel", SCOPE)).toBe(`${SCOPE} .panel`)
    expect(scopeSelector("ul li::marker", SCOPE)).toBe(`${SCOPE} ul li::marker`)
    expect(scopeSelector("*", SCOPE)).toBe(`${SCOPE} *`)
  })

  test("maps :root, :host, html and body onto the mount itself", () => {
    expect(scopeSelector(":root", SCOPE)).toBe(SCOPE)
    expect(scopeSelector(":root.dark", SCOPE)).toBe(`${SCOPE}.dark`)
    expect(scopeSelector(":root [data-color-scheme]", SCOPE)).toBe(`${SCOPE} [data-color-scheme]`)
    expect(scopeSelector(":host", SCOPE)).toBe(SCOPE)
    expect(scopeSelector("html", SCOPE)).toBe(SCOPE)
    expect(scopeSelector("body", SCOPE)).toBe(SCOPE)
    expect(scopeSelector("body.theme-dark", SCOPE)).toBe(`${SCOPE}.theme-dark`)
    expect(scopeSelector("html body", SCOPE)).toBe(SCOPE)
    expect(scopeSelector("body .reset", SCOPE)).toBe(`${SCOPE} .reset`)
  })
})

describe("scopeExtensionID", () => {
  test("prefers the explicit scope option", () => {
    expect(scopeExtensionID({ scope: "override.demo" })).toBe("override.demo")
  })

  test("rejects invalid ids and missing manifests", () => {
    expect(() => scopeExtensionID({ scope: "nodot" })).toThrow("invalid")
    expect(() => scopeExtensionID({ cwd: os.tmpdir() })).toThrow(/opencode\.id|read package\.json/)
  })

  test("resolves opencode.id from the fixture package.json", () => {
    expect(scopeExtensionID({ cwd: path.resolve(import.meta.dir, "fixture") })).toBe(ID)
  })
})

describe("extension kit vite build", () => {
  test("scopes the emitted bundle CSS to the extension mount", async () => {
    const fixtureDir = path.resolve(import.meta.dir, "fixture")
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-kit-scope-"))
    const previousCwd = process.cwd()
    process.chdir(fixtureDir)
    try {
      await build({
        root: fixtureDir,
        configFile: false,
        logLevel: "error",
        plugins: extensionKit({
          entry: path.join(fixtureDir, "src/web.ts"),
          outDir,
        }),
      })
    } finally {
      process.chdir(previousCwd)
    }

    const css = fs.readFileSync(path.join(outDir, "index.css"), "utf8")

    // Regular selectors are scoped, grouped selectors split correctly and
    // commas inside attribute selectors survive.
    expect(css).toContain(`${SCOPE} .scope-fixture-title`)
    expect(css).toContain(`${SCOPE} [data-note="a,b"].scope-fixture-tag:before`)
    expect(css).toContain(`${SCOPE} .scope-fixture-panel :is(.scope-fixture-a,.scope-fixture-b)`)
    expect(css).toContain(`${SCOPE} .scope-fixture-wide`)
    expect(css).toContain(`${SCOPE} .scope-fixture-reset`)

    // :root variables become custom properties on the mount, not the host root.
    expect(css).toContain(`${SCOPE}{--scope-fixture-accent:`)
    expect(css).toContain(`${SCOPE}{--scope-fixture-wide:`)

    // html/body resets target the mount, never the host document.
    expect(css).toContain(`${SCOPE}{margin:0}`)

    // Keyframes keep their steps and their name reference.
    expect(css).toContain("@keyframes scope-fixture-pulse")
    expect(css).not.toContain(`${SCOPE} from`)
    expect(css).toContain("animation-name:scope-fixture-pulse")

    // Font-face and property registrations stay global.
    expect(css).toContain("@font-face")
    expect(css).toContain("Scope Fixture Font")
    expect(css).toContain("@property --scope-fixture-size")

    // Nothing leaked outside the scope apart from the intended at-rules.
    const outsideScope = css.split("}").filter((chunk) => chunk.includes(".scope-fixture") && !chunk.includes(SCOPE))
    expect(outsideScope).toEqual([])
    fs.rmSync(outDir, { recursive: true, force: true })
  })
})
