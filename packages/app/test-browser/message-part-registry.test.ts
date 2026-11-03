import { describe, expect, test } from "bun:test"
// message-part.tsx needs the browser build of solid-js, so this lives in test-browser.
import { PART_MAPPING, registerPartComponent, ToolRegistry } from "@opencode-ai/ui/message-part"

describe("ToolRegistry", () => {
  test("disposer removes a fresh registration", () => {
    const render = () => null
    const dispose = ToolRegistry.register({ name: "test_fresh_tool", render })
    expect(ToolRegistry.render("test_fresh_tool")).toBe(render)
    dispose()
    expect(ToolRegistry.render("test_fresh_tool")).toBeUndefined()
  })

  test("disposer restores the previous registration", () => {
    const first = () => null
    const second = () => null
    const disposeFirst = ToolRegistry.register({ name: "test_restore_tool", render: first })
    const disposeSecond = ToolRegistry.register({ name: "test_restore_tool", render: second })
    expect(ToolRegistry.render("test_restore_tool")).toBe(second)
    disposeSecond()
    expect(ToolRegistry.render("test_restore_tool")).toBe(first)
    disposeFirst()
    expect(ToolRegistry.render("test_restore_tool")).toBeUndefined()
  })

  test("stale disposer does not remove a newer registration", () => {
    const first = () => null
    const second = () => null
    const disposeFirst = ToolRegistry.register({ name: "test_stale_tool", render: first })
    const disposeSecond = ToolRegistry.register({ name: "test_stale_tool", render: second })
    disposeFirst()
    expect(ToolRegistry.render("test_stale_tool")).toBe(second)
    disposeSecond()
  })

  test("built-in renderers are registered", () => {
    expect(ToolRegistry.render("bash")).toBeDefined()
  })
})

describe("registerPartComponent", () => {
  test("disposer restores the previous component", () => {
    const original = PART_MAPPING["text"]
    const replacement = () => null
    const dispose = registerPartComponent("text", replacement)
    expect(PART_MAPPING["text"]).toBe(replacement)
    dispose()
    expect(PART_MAPPING["text"]).toBe(original)
  })

  test("disposer removes a fresh type and ignores stale calls", () => {
    const first = () => null
    const second = () => null
    const disposeFirst = registerPartComponent("test-part", first)
    const disposeSecond = registerPartComponent("test-part", second)
    disposeFirst()
    expect(PART_MAPPING["test-part"]).toBe(second)
    disposeSecond()
    expect(PART_MAPPING["test-part"]).toBe(first)
    disposeFirst()
    expect("test-part" in PART_MAPPING).toBe(false)
  })
})
