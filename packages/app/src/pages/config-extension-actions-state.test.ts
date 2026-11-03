import { describe, expect, test } from "bun:test"
import type { ExtensionInfo } from "@/extensions/types"
import { extensionToggleBlocked } from "./config-extension-actions-state"

const item: ExtensionInfo = {
  id: "test.viewer",
  displayName: "Viewer",
  version: "1.0.0",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: {},
}
const input = { item, enabled: true, busy: false, dirty: false, saving: false }

describe("extension management gates", () => {
  test("blocks management in safe mode without bypassing the global gate", () => {
    expect(extensionToggleBlocked({ ...input, enabled: false })).toBe("safe-mode")
  })
  test("blocks repeated requests and settings saves", () => {
    expect(extensionToggleBlocked({ ...input, busy: true })).toBe("busy")
    expect(extensionToggleBlocked({ ...input, saving: true })).toBe("busy")
  })
  test("requires settings changes to be resolved first", () => {
    expect(extensionToggleBlocked({ ...input, dirty: true })).toBe("dirty")
  })
  test("blocks enabling incompatible entries but permits disabling them", () => {
    expect(extensionToggleBlocked({ ...input, item: { ...item, state: "incompatible", enabled: false } })).toBe(
      "incompatible",
    )
    expect(extensionToggleBlocked({ ...input, item: { ...item, state: "incompatible" } })).toBeUndefined()
  })
  test("permits retrying error entries without treating enabled as activation", () => {
    expect(extensionToggleBlocked({ ...input, item: { ...item, state: "error", enabled: false } })).toBeUndefined()
    expect(extensionToggleBlocked(input)).toBeUndefined()
  })
})
