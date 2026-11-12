import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { extensionWarningLabel } from "./warnings"

// The web.apiVersion warning code is emitted by the server manifest loader in
// packages/opencode/src/extension/manifest.ts; the app-side parser here must
// keep recognizing the emitted shape. Read the source and compare the literal
// prefix so the copies cannot drift apart.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

const emitted = (() => {
  const match = /`web\.apiVersion:\$\{manifest\.web\.apiVersion\}`/.exec(
    read("../../../opencode/src/extension/manifest.ts"),
  )
  if (!match) throw new Error("Could not find the web.apiVersion warning code in manifest.ts")
  return match[0]
})()

describe("extension warning labels", () => {
  test("manifest.ts emits the web.apiVersion:<version> code shape", () => {
    expect(emitted).toContain("web.apiVersion:")
  })

  test("extensionWarningLabel parses the code and exposes the declared version", () => {
    expect(extensionWarningLabel("web.apiVersion:2")).toEqual({
      key: "config.extensions.warnings.webApiVersion",
      params: { version: "2" },
    })
  })

  test("unknown or malformed codes render verbatim", () => {
    for (const warning of ["web.apiVersion", "web.apiVersion:", "other.code:1", ""]) {
      expect(extensionWarningLabel(warning)).toBeUndefined()
    }
  })
})
