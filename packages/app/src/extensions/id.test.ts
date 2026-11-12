import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  EXTENSION_ID_MAX,
  EXTENSION_ID_PATTERN,
  extensionToolName,
  extensionToolNamespace,
  extensionToolRendererNames,
  isExtensionID,
} from "./id"

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

// D1: the registry exposes extension tools as `<ns>_<tool>`; renderer
// contributions keep the unprefixed name and the host prefixes at match time.
describe("extension tool namespacing", () => {
  test("namespace derives from the last id segment with - mapped to _", () => {
    expect(extensionToolNamespace("local.wls-repl")).toBe("wls_repl")
    expect(extensionToolNamespace("example.hello-viewer")).toBe("hello_viewer")
    expect(extensionToolNamespace("local.mathematica-notebook")).toBe("mathematica_notebook")
  })

  test("tool name prefixes with the namespace", () => {
    expect(extensionToolName("local.wls-repl", "wolfram_eval")).toBe("wls_repl_wolfram_eval")
  })

  test("backend derivation in extension/tools.ts uses the same formula", () => {
    const source = read("../../../opencode/src/extension/tools.ts")
    expect(source).toContain('id.slice(id.lastIndexOf(".") + 1).replaceAll("-", "_")')
    expect(source).toContain("`${extensionToolNamespace(id)}_${tool}`")
  })

  test("renderer names cover the prefixed name and the legacy alias", () => {
    const names = extensionToolRendererNames("local.wls-repl", "wolfram_eval")
    expect(names.primary).toBe("wls_repl_wolfram_eval")
    expect(names.legacy).toBe("wolfram_eval")
    // A manifest that already declares the prefixed name double-prefixes as
    // primary, and the single-prefixed name survives as the legacy alias.
    expect(extensionToolRendererNames("local.wls-repl", "wls_repl_wolfram_eval")).toEqual({
      primary: "wls_repl_wls_repl_wolfram_eval",
      legacy: "wls_repl_wolfram_eval",
    })
  })
})
