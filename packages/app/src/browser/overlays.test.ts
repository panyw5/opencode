import { afterEach, describe, expect, test } from "bun:test"
import { browserOverlay } from "./overlays"

afterEach(() => document.body.replaceChildren())
const bounds = { x: 100, y: 100, width: 500, height: 500 }
function overlay(kind: string, x = 200, y = 50) {
  const element = document.createElement("div")
  element.setAttribute("data-component", kind)
  element.getBoundingClientRect = () => ({
    x,
    y,
    left: x,
    top: y,
    right: x + 200,
    bottom: y + 200,
    width: 200,
    height: 200,
    toJSON: () => ({}),
  })
  document.body.append(element)
  return element
}

describe("browser overlay detection", () => {
  test("ignores the enlarged browser itself but detects overlays inside it", () => {
    const surface = overlay("browser")
    surface.setAttribute("role", "dialog")
    surface.setAttribute("data-browser-maximized", "")
    expect(browserOverlay(bounds)).toBeUndefined()
    const menu = overlay("popover-content")
    surface.append(menu)
    expect(browserOverlay(bounds)).toBe("popover-content")
  })
  test("recognizes project menus, status popovers, tooltips and nested menus", () => {
    for (const kind of ["dropdown-menu-content", "popover-content", "tooltip", "dropdown-menu-sub-content"]) {
      const element = overlay(kind)
      expect(browserOverlay(bounds)).toBe(kind)
      element.remove()
    }
  })
  test("leaves non-overlapping and closed overlays alone", () => {
    const element = overlay("popover-content", 0, 0)
    expect(browserOverlay({ ...bounds, x: 600 })).toBeUndefined()
    element.setAttribute("data-closed", "")
    expect(browserOverlay(bounds)).toBeUndefined()
    element.removeAttribute("data-closed")
    element.style.display = "none"
    expect(browserOverlay(bounds)).toBeUndefined()
    element.style.display = "block"
    element.style.visibility = "hidden"
    expect(browserOverlay(bounds)).toBeUndefined()
  })
  test("handles dialogs and listboxes without component markers", () => {
    const element = overlay("custom")
    element.setAttribute("role", "dialog")
    expect(browserOverlay(bounds)).toBe("custom")
    element.removeAttribute("data-component")
    element.setAttribute("role", "listbox")
    expect(browserOverlay(bounds)).toBe("listbox")
  })
})
