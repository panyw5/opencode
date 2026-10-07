import { describe, expect, test } from "bun:test"
// message-part.tsx needs the browser build of solid-js (its @solidjs/router
// import calls client-only APIs at module load), so this lives in test-browser.
import { createMemo, createRoot } from "solid-js"
import { isBuiltinToolRenderer, registerBuiltinTool, ToolRegistry } from "@opencode-ai/ui/message-part"

// Regression coverage for the ToolRegistry version signal: registrations and
// disposals happen while tool parts are already mounted (late extension
// activation, hot-reload disposal), so a mounted placeholder must reactively
// swap to the contributed renderer and back.

describe("ToolRegistry reactivity", () => {
  test("a subscribed memo sees a late registration replace the placeholder and the dispose fall back", () => {
    createRoot((dispose) => {
      const memo = createMemo(() => {
        ToolRegistry.version()
        return ToolRegistry.render("registry_reactive_tool") ?? "placeholder"
      })
      expect(memo()).toBe("placeholder")

      const render = () => null
      const unregister = ToolRegistry.register({ name: "registry_reactive_tool", render })
      expect(memo()).toBe(render)

      unregister()
      expect(memo()).toBe("placeholder")
      dispose()
    })
  })

  test("a subscribed memo sees dispose restore the previous registration", () => {
    createRoot((dispose) => {
      const first = () => null
      const second = () => null
      const memo = createMemo(() => {
        ToolRegistry.version()
        return ToolRegistry.render("registry_restore_tool") ?? "placeholder"
      })

      const disposeFirst = ToolRegistry.register({ name: "registry_restore_tool", render: first })
      const disposeSecond = ToolRegistry.register({ name: "registry_restore_tool", render: second })
      expect(memo()).toBe(second)

      disposeSecond()
      expect(memo()).toBe(first)

      disposeFirst()
      expect(memo()).toBe("placeholder")
      dispose()
    })
  })

  test("a stale disposer does not notify or remove a newer registration", () => {
    createRoot((dispose) => {
      const first = () => null
      const second = () => null
      const memo = createMemo(() => {
        ToolRegistry.version()
        return ToolRegistry.render("registry_stale_tool") ?? "placeholder"
      })

      const disposeFirst = ToolRegistry.register({ name: "registry_stale_tool", render: first })
      const disposeSecond = ToolRegistry.register({ name: "registry_stale_tool", render: second })
      expect(memo()).toBe(second)

      disposeFirst()
      expect(memo()).toBe(second)
      disposeSecond()
      dispose()
    })
  })
})

// The builtinTools protection from P2 must stay intact: host-registered
// builtins are marked at module initialization so a contribution can replace
// its own placeholder but never a builtin renderer (enforced by the host).
describe("builtin tool markers", () => {
  test("registerBuiltinTool marks the tool, plain registration does not", () => {
    expect(isBuiltinToolRenderer("registry_builtin_marker_tool")).toBe(false)

    const disposeBuiltin = registerBuiltinTool({ name: "registry_builtin_marker_tool", render: () => null })
    expect(isBuiltinToolRenderer("registry_builtin_marker_tool")).toBe(true)
    disposeBuiltin()

    const disposePlain = ToolRegistry.register({ name: "registry_plain_marker_tool", render: () => null })
    expect(isBuiltinToolRenderer("registry_plain_marker_tool")).toBe(false)
    disposePlain()
  })
})
