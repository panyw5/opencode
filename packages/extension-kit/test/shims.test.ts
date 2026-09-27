import { describe, expect, test } from "bun:test"
import { SHARED_EXPORTS, sharedShim } from "../shims.js"

const runtimeModules = ["solid-js", "solid-js/web", "solid-js/store"] as const
const uiModules = ["@opencode-ai/ui/button", "@opencode-ai/ui/spinner"] as const

describe("extension host shims", () => {
  for (const id of runtimeModules) {
    test(`keeps ${id} exports aligned with the installed runtime`, async () => {
      const runtime = await import(id)
      expect([...SHARED_EXPORTS[id]].toSorted()).toEqual(Object.keys(runtime).toSorted())
    })
  }

  for (const id of uiModules) {
    test(`keeps ${id} exports aligned with the installed runtime`, async () => {
      const runtime = await import(id)
      expect([...SHARED_EXPORTS[id]].toSorted()).toEqual(Object.keys(runtime).toSorted())
    })
  }

  test("emits static named exports through the host module table", () => {
    const source = sharedShim("@opencode-ai/ui/button")
    expect(source).toContain('modules?.["@opencode-ai/ui/button"]')
    expect(source).toContain('export const Button = m["Button"]')
    expect(source).not.toContain("export *")
  })

  test("rejects unknown modules", () => {
    expect(() => sharedShim("solid-js/html")).toThrow("Unsupported OpenCode extension host module")
  })
})
