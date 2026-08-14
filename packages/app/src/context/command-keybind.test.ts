import { describe, expect, test } from "bun:test"
import { formatKeybind, matchKeybind, parseKeybind, shouldPreserveNativeEditableKeybind } from "./command"

describe("command keybind helpers", () => {
  test("parseKeybind handles aliases and multiple combos", () => {
    const keybinds = parseKeybind("control+option+k, mod+shift+comma")

    expect(keybinds).toHaveLength(2)
    expect(keybinds[0]).toEqual({
      key: "k",
      ctrl: true,
      meta: false,
      shift: false,
      alt: true,
    })
    expect(keybinds[1]?.shift).toBe(true)
    expect(keybinds[1]?.key).toBe("comma")
    expect(Boolean(keybinds[1]?.ctrl || keybinds[1]?.meta)).toBe(true)
  })

  test("parseKeybind treats none and empty as disabled", () => {
    expect(parseKeybind("none")).toEqual([])
    expect(parseKeybind("")).toEqual([])
  })

  test("matchKeybind normalizes punctuation keys", () => {
    const keybinds = parseKeybind("ctrl+comma, shift+plus, meta+space")

    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: ",", ctrlKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: "+", shiftKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: " ", metaKey: true }))).toBe(true)
    expect(matchKeybind(keybinds, new KeyboardEvent("keydown", { key: ",", ctrlKey: true, altKey: true }))).toBe(false)
  })

  test("matchKeybind supports bracket keys", () => {
    const keybinds = parseKeybind("mod+alt+[, mod+alt+]")
    const prev = keybinds[0]
    const next = keybinds[1]

    expect(
      matchKeybind(
        keybinds,
        new KeyboardEvent("keydown", { key: "[", ctrlKey: prev?.ctrl, metaKey: prev?.meta, altKey: true }),
      ),
    ).toBe(true)
    expect(
      matchKeybind(
        keybinds,
        new KeyboardEvent("keydown", { key: "]", ctrlKey: next?.ctrl, metaKey: next?.meta, altKey: true }),
      ),
    ).toBe(true)
  })

  test("matchKeybind matches shift punctuation via physical code", () => {
    const comma = parseKeybind("ctrl+shift+comma")
    const semicolon = parseKeybind("ctrl+shift+;")
    const period = parseKeybind("ctrl+shift+.")

    expect(matchKeybind(comma, new KeyboardEvent("keydown", { key: "<", code: "Comma", ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(
      matchKeybind(semicolon, new KeyboardEvent("keydown", { key: ":", code: "Semicolon", ctrlKey: true, shiftKey: true })),
    ).toBe(true)
    expect(
      matchKeybind(period, new KeyboardEvent("keydown", { key: ">", code: "Period", ctrlKey: true, shiftKey: true })),
    ).toBe(true)
    expect(matchKeybind(comma, new KeyboardEvent("keydown", { key: "<", code: "Comma", ctrlKey: true }))).toBe(false)
  })

  test("keyFromEvent falls back to the event key when code is unknown", () => {
    expect(matchKeybind(parseKeybind("ctrl+comma"), new KeyboardEvent("keydown", { key: ",", ctrlKey: true }))).toBe(true)
    expect(matchKeybind(parseKeybind("ctrl+a"), new KeyboardEvent("keydown", { key: "a", code: "KeyA", ctrlKey: true }))).toBe(
      true,
    )
  })

  test("formatKeybind returns human readable output", () => {
    const display = formatKeybind("ctrl+alt+arrowup")

    expect(display).toContain("↑")
    expect(display.includes("Ctrl") || display.includes("⌃")).toBe(true)
    expect(display.includes("Alt") || display.includes("⌥")).toBe(true)
    expect(formatKeybind("none")).toBe("")
  })

  test("formatKeybind prefers the first combo", () => {
    const display = formatKeybind("mod+k,mod+p")

    expect(display.includes("K") || display.includes("k")).toBe(true)
    expect(display.includes("P") || display.includes("p")).toBe(false)
  })

  test("preserves macOS editable cursor movement keybinds", () => {
    expect(shouldPreserveNativeEditableKeybind(new KeyboardEvent("keydown", { key: "ArrowUp", metaKey: true }), true)).toBe(
      true,
    )
    expect(
      shouldPreserveNativeEditableKeybind(new KeyboardEvent("keydown", { key: "ArrowDown", metaKey: true }), true),
    ).toBe(true)
    expect(
      shouldPreserveNativeEditableKeybind(
        new KeyboardEvent("keydown", { key: "ArrowUp", metaKey: true, shiftKey: true }),
        true,
      ),
    ).toBe(false)
    expect(shouldPreserveNativeEditableKeybind(new KeyboardEvent("keydown", { key: "ArrowUp", metaKey: true }), false)).toBe(
      false,
    )
  })
})
