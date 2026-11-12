import { describe, expect, spyOn, test } from "bun:test"
import { requestExtensionDisable } from "./mount"

describe("requestExtensionDisable", () => {
  test("disables the extension through the host setEnabled API", async () => {
    const calls: Array<[string, boolean]> = []
    const info = spyOn(console, "info").mockImplementation(() => {})
    try {
      await requestExtensionDisable({
        id: "acme.demo",
        surface: "panel:main",
        setEnabled: async (id, enabled) => {
          calls.push([id, enabled])
        },
      })
      expect(calls).toEqual([["acme.demo", false]])
    } finally {
      info.mockRestore()
    }
  })

  test("logs a string warning instead of throwing when the toggle rejects", async () => {
    const info = spyOn(console, "info").mockImplementation(() => {})
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const result = await requestExtensionDisable({
        id: "acme.demo",
        surface: "tool:demo",
        setEnabled: () => Promise.reject(new Error("toggle failed")),
      })
      expect(result).toBeUndefined()
      expect(warn.mock.calls).toHaveLength(1)
      expect(warn.mock.calls[0]).toHaveLength(1)
      expect(typeof warn.mock.calls[0][0]).toBe("string")
      expect(warn.mock.calls[0][0] as string).toContain("acme.demo")
      expect(warn.mock.calls[0][0] as string).toContain("toggle failed")
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })
})
