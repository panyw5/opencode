import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { extensionWarningLabel } from "./warnings"

// The warning codes are emitted by the server manifest loader in
// packages/opencode/src/extension/manifest.ts (apiVersion codes) and by
// registry.ts/install.ts via the ISOLATION_INLINE_WARNING constant; the
// app-side parser here must keep recognizing the emitted shapes. Read the
// source and compare the literals so the copies cannot drift apart.

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

  test("manifest.ts declares the server.isolation:inline stable code", () => {
    expect(read("../../../opencode/src/extension/manifest.ts")).toContain('"server.isolation:inline"')
  })

  test("extensionWarningLabel parses the code and exposes the declared version", () => {
    expect(extensionWarningLabel("web.apiVersion:2")).toEqual({
      key: "config.extensions.warnings.webApiVersion",
      params: { version: "2" },
    })
  })

  test("extensionWarningLabel maps server.apiVersion and inline isolation codes", () => {
    expect(extensionWarningLabel("server.apiVersion:2")).toEqual({
      key: "config.extensions.warnings.serverApiVersion",
      params: { version: "2" },
    })
    expect(extensionWarningLabel("server.isolation:inline")).toEqual({
      key: "config.extensions.warnings.inlineIsolation",
    })
  })

  test("unknown or malformed codes render verbatim", () => {
    for (const warning of ["web.apiVersion", "web.apiVersion:", "server.apiVersion:", "other.code:1", ""]) {
      expect(extensionWarningLabel(warning)).toBeUndefined()
    }
  })

  test("installed details and the install preview both route warnings through the label map", () => {
    // UI contract (T5.8): the detail page renders Info.warnings and the
    // installation dialog renders prepared().warnings; both must pass each code
    // through extensionWarningLabel so server.isolation:inline gets localized
    // text instead of a raw code.
    const detail = read("../pages/config-extension-detail.tsx")
    expect(detail).toContain("props.item.warnings")
    expect(detail).toContain("extensionWarningLabel(warning)")
    const dialog = read("../components/dialog-install-extension.tsx")
    expect(dialog).toContain("prepared().warnings")
    expect(dialog).toContain("extensionWarningLabel(warning)")
    expect(dialog).toContain('data-preview="warnings"')
  })
})
