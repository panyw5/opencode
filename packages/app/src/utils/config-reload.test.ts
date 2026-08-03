import { describe, expect, test } from "bun:test"
import { refreshAfterConfigWrite } from "./config-reload"

describe("refreshAfterConfigWrite", () => {
  test("refreshes runtime config before local data", async () => {
    const calls: string[] = []

    await refreshAfterConfigWrite({
      source: "jsonc-agent",
      refreshConfig: async () => {
        calls.push("runtime")
      },
      refresh: () => calls.push("refresh"),
    })

    expect(calls).toEqual(["runtime", "refresh"])
  })

  test("does not refresh local data when runtime config refresh fails", async () => {
    const calls: string[] = []
    const error = new Error("refresh failed")

    await expect(
      refreshAfterConfigWrite({
        source: "jsonc-agent",
        refreshConfig: async () => {
          calls.push("runtime")
          throw error
        },
        refresh: () => calls.push("refresh"),
      }),
    ).rejects.toBe(error)

    expect(calls).toEqual(["runtime"])
  })
})
