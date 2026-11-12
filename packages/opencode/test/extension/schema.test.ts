import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { FileViewerContribution, Manifest, PERMISSIONS } from "../../src/extension/schema"

const viewer = { id: "hello", title: "Hello", extensions: ["hello"] }

describe("extension file viewer content schema", () => {
  test("preserves legacy and explicit text/self ownership", () => {
    const decode = Schema.decodeUnknownSync(FileViewerContribution)
    expect(decode(viewer).content).toBeUndefined()
    for (const content of ["text", "self"] as const) {
      expect(decode({ ...viewer, content }).content).toBe(content)
    }
  })

  test("rejects unsupported content ownership", () => {
    const decode = Schema.decodeUnknownSync(FileViewerContribution)
    for (const content of ["binary", "", true, null]) {
      expect(() => decode({ ...viewer, content })).toThrow()
    }
  })

  test("retains content in the complete extension manifest", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)({
      manifestVersion: 1,
      id: "test.viewer",
      displayName: "Viewer",
      contributes: { fileViewers: [{ ...viewer, mode: "replace", content: "self" }] },
    })
    expect(manifest.contributes?.fileViewers?.[0].content).toBe("self")
  })
})

describe("extension permission vocabulary", () => {
  test("covers every permission declared by the bundled extensions", () => {
    expect(PERMISSIONS).toEqual(["fs:read", "fs:write", "process:spawn", "network", "tools", "settings:secret"])
  })

  test("accepts unknown permission strings for forward compatibility", () => {
    const manifest = Schema.decodeUnknownSync(Manifest)({
      manifestVersion: 1,
      id: "test.permissions",
      displayName: "Permissions",
      permissions: [...PERMISSIONS, "unknown:thing"],
    })
    expect(manifest.permissions).toContain("unknown:thing")
  })
})
