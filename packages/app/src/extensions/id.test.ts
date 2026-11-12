import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { EXTENSION_ID_MAX, EXTENSION_ID_PATTERN, isExtensionID } from "./id"

// The extension id pattern is mirrored in three places that cannot share a
// runtime import: the server schema (authoritative), the web host copy in
// id.ts, and the plain-JS copy in extension-kit/scope.js used by extension
// builds. Read each source file and compare the regex literals byte-for-byte
// so the copies cannot drift apart.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

const literal = (path: string, name: string) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(\\/[^/\\n]+\\/[a-z]*)`).exec(read(path))
  if (!match) throw new Error(`Could not find the ${name} regex literal in ${path}`)
  return match[1]
}

const schema = literal("../../../opencode/src/extension/schema.ts", "ID_PATTERN")
const app = literal("./id.ts", "EXTENSION_ID_PATTERN")
const kit = literal("../../../extension-kit/scope.js", "EXTENSION_ID_PATTERN")

describe("extension id pattern parity", () => {
  test("app id.ts mirrors schema.ts ID_PATTERN literally", () => {
    expect(app).toBe(schema)
  })

  test("extension-kit scope.js mirrors schema.ts ID_PATTERN literally", () => {
    expect(kit).toBe(schema)
  })

  test("the exported pattern is the mirrored literal", () => {
    expect(`/${EXTENSION_ID_PATTERN.source}/`).toBe(schema)
  })

  test("the exported length cap matches the ExtensionID schema bound", () => {
    // `ExtensionID` in schema.ts = ID_PATTERN plus `value.length <= 64`.
    expect(read("../../../opencode/src/extension/schema.ts")).toContain(
      `value.length <= ${EXTENSION_ID_MAX}`,
    )
  })

  test("isExtensionID applies pattern and cap together", () => {
    expect(isExtensionID("acme.demo")).toBe(true)
    expect(isExtensionID("nodot")).toBe(false)
    expect(isExtensionID("Acme.demo")).toBe(false)
    expect(isExtensionID(`${"a".repeat(63)}.demo`)).toBe(false)
    expect(isExtensionID(`${"a".repeat(59)}.demo`)).toBe(true)
  })
})
