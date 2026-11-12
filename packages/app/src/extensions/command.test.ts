import { describe, expect, spyOn, test } from "bun:test"
import { createExtensionCommandHandler } from "./command"

function handler(run: (source?: "palette" | "keybind" | "slash" | "menu") => void | Promise<void>) {
  const toasts: Array<{ variant: "error"; title: string; description: string }> = []
  const onSelect = createExtensionCommandHandler({
    extensionID: "acme.demo",
    commandID: "restart",
    title: "Restart demo",
    run,
    toast: (input) => toasts.push(input),
  })
  return { onSelect, toasts }
}

describe("extension command error isolation", () => {
  test("forwards the command source and waits for completion", async () => {
    const sources: unknown[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => (release = resolve))
    const { onSelect, toasts } = handler((source) => {
      sources.push(source)
      return pending
    })
    let completed = false
    const result = onSelect("slash").then(() => (completed = true))
    await Promise.resolve()
    expect(sources).toEqual(["slash"])
    expect(completed).toBe(false)
    release()
    await result
    expect(completed).toBe(true)
    expect(toasts).toEqual([])
  })

  for (const mode of ["sync", "async", "non-error"] as const) {
    test(`contains ${mode} command failures and reports a string log and toast`, async () => {
      const log = spyOn(console, "error").mockImplementation(() => {})
      try {
        const { onSelect, toasts } = handler(() => {
          if (mode === "async") return Promise.reject(new Error("command failed"))
          if (mode === "non-error") throw "command failed"
          throw new Error("command failed")
        })
        await expect(onSelect("keybind")).resolves.toBeUndefined()
        expect(toasts).toEqual([{ variant: "error", title: "Restart demo", description: "command failed" }])
        expect(log.mock.calls).toHaveLength(1)
        expect(log.mock.calls[0]).toHaveLength(1)
        const [message] = log.mock.calls[0]
        expect(typeof message).toBe("string")
        expect(message).toContain("acme.demo")
        expect(message).toContain("restart")
        expect(message).toContain("command failed")
      } finally {
        log.mockRestore()
      }
    })
  }

  test("a failed invocation does not disable later invocations", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {})
    try {
      let attempts = 0
      const { onSelect, toasts } = handler(async () => {
        if (++attempts === 1) throw new Error("first attempt failed")
      })
      await onSelect("palette")
      await onSelect("menu")
      expect(attempts).toBe(2)
      expect(toasts).toHaveLength(1)
    } finally {
      log.mockRestore()
    }
  })
})
