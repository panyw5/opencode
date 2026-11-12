import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { EXTENSION_PERMISSIONS, isKnownExtensionPermission } from "./permissions"

// The permission vocabulary is declared in two places that cannot share a
// runtime import: the server schema (authoritative) and the web host copy in
// permissions.ts. Read the schema source and compare the string literals so
// the copies cannot drift apart.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

const schema = (() => {
  const match = /\bPERMISSIONS\s*=\s*\[([^\]]*)\]/.exec(read("../../../opencode/src/extension/schema.ts"))
  if (!match) throw new Error("Could not find the PERMISSIONS array literal in schema.ts")
  return [...match[1].matchAll(/"([^"]+)"/g)].map((literal) => literal[1])
})()

describe("extension permission vocabulary parity", () => {
  test("app permissions.ts mirrors schema.ts PERMISSIONS literally", () => {
    expect<string[]>([...EXTENSION_PERMISSIONS]).toEqual(schema)
  })

  test("isKnownExtensionPermission accepts only vocabulary entries", () => {
    for (const permission of EXTENSION_PERMISSIONS) expect(isKnownExtensionPermission(permission)).toBe(true)
    for (const permission of ["unknown:thing", "", "FS:READ", "fs", "tools "])
      expect(isKnownExtensionPermission(permission)).toBe(false)
  })
})
