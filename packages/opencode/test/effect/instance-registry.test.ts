import { describe, expect, test } from "bun:test"
import { disposeInstance, registerDisposer } from "@/effect/instance-registry"

describe("instance-registry disposeInstance", () => {
  test("returns a structured failure list without dropping errors", async () => {
    let okRan = 0
    const unregisterSlow = registerDisposer(async () => {
      throw new Error("slow disposer exploded")
    })
    const unregisterOk = registerDisposer(async () => {
      okRan++
    })
    try {
      const result = await disposeInstance("/tmp/opencode-test-registry-disposal")
      expect(result.ok).toBe(false)
      expect(result.failures).toHaveLength(1)
      expect(result.failures[0].error).toBeInstanceOf(Error)
      expect(okRan).toBe(1)
    } finally {
      unregisterSlow()
      unregisterOk()
    }
  })

  test("reports ok when every disposer succeeds", async () => {
    const unregister = registerDisposer(async () => {})
    try {
      const result = await disposeInstance("/tmp/opencode-test-registry-disposal")
      expect(result.ok).toBe(true)
      expect(result.failures).toHaveLength(0)
    } finally {
      unregister()
    }
  })
})
