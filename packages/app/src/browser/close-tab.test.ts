import { afterEach, describe, expect, mock, test } from "bun:test"
import { browserPanelHasFocus, closeFocusedBrowserTab, CLOSE_BROWSER_TAB_COMMAND } from "./close-tab"

afterEach(() => document.body.replaceChildren())

function fixture() {
  const panel = document.createElement("div")
  panel.id = "browser-panel"
  panel.tabIndex = -1
  const address = document.createElement("input")
  const tab = document.createElement("button")
  const outside = document.createElement("input")
  panel.append(address, tab)
  document.body.append(panel, outside)
  return { panel, address, tab, outside }
}

describe("focused browser tab close", () => {
  test("routes commands from the floating browser without targeting the hidden dock", () => {
    const { panel } = fixture()
    panel.setAttribute("inert", "")
    panel.setAttribute("aria-hidden", "true")
    const floating = document.createElement("div")
    floating.setAttribute("data-browser-maximized", "")
    const address = document.createElement("input")
    floating.append(address)
    document.body.append(floating)
    address.focus()
    const trigger = mock(() => {})
    expect(closeFocusedBrowserTab("keybind", trigger)).toBe(true)
    expect(trigger).toHaveBeenCalledWith(CLOSE_BROWSER_TAB_COMMAND, "keybind")
    floating.setAttribute("inert", "")
    expect(browserPanelHasFocus()).toBe(false)
  })
  test("routes menu and configurable keybind commands from browser chrome", () => {
    const { panel, address, tab } = fixture()
    const trigger = mock(() => {})
    for (const target of [panel, address, tab]) {
      target.focus()
      expect(browserPanelHasFocus()).toBe(true)
      expect(closeFocusedBrowserTab("menu", trigger)).toBe(true)
      expect(closeFocusedBrowserTab("keybind", trigger)).toBe(true)
    }
    expect(trigger).toHaveBeenCalledTimes(6)
    expect(trigger).toHaveBeenCalledWith(CLOSE_BROWSER_TAB_COMMAND, "menu")
    expect(trigger).toHaveBeenCalledWith(CLOSE_BROWSER_TAB_COMMAND, "keybind")
  })

  test("does not redirect explicit palette, slash or programmatic session close", () => {
    const { address } = fixture()
    address.focus()
    const trigger = mock(() => {})
    for (const source of ["palette", "slash", undefined] as const) {
      expect(closeFocusedBrowserTab(source, trigger)).toBe(false)
    }
    expect(trigger).not.toHaveBeenCalled()
  })

  test("never routes an unfocused, hidden, inert or missing panel", () => {
    const { panel, address, outside } = fixture()
    const trigger = mock(() => {})
    outside.focus()
    expect(closeFocusedBrowserTab("menu", trigger)).toBe(false)
    address.focus()
    panel.setAttribute("aria-hidden", "true")
    expect(closeFocusedBrowserTab("menu", trigger)).toBe(false)
    panel.setAttribute("aria-hidden", "false")
    panel.setAttribute("inert", "")
    expect(closeFocusedBrowserTab("menu", trigger)).toBe(false)
    panel.remove()
    expect(closeFocusedBrowserTab("menu", trigger)).toBe(false)
    expect(trigger).not.toHaveBeenCalled()
  })
})
