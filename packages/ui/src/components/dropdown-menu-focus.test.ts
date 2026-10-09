import { describe, expect, test } from "bun:test"
import { keepDialogFocus } from "./dropdown-menu-focus"

describe("menu close autofocus", () => {
  test("guards the library's synchronous trigger focus and restores the dialog input", async () => {
    const dialog = document.createElement("div")
    dialog.dataset.slot = "dialog-content"
    dialog.setAttribute("data-expanded", "")
    const input = document.createElement("input")
    dialog.append(input)
    const trigger = document.createElement("button")
    trigger.dataset.slot = "dropdown-menu-trigger"
    document.body.append(dialog, trigger)
    input.focus()
    let outside = 0
    const observer = (event: FocusEvent) => {
      if (event.target === trigger) outside++
    }
    document.addEventListener("focusin", observer, true)
    keepDialogFocus(new Event("closeAutoFocus", { cancelable: true }))
    trigger.focus()
    expect(outside).toBe(0)
    await Promise.resolve()
    expect(document.activeElement).toBe(input)
    trigger.focus()
    expect(outside).toBe(1)
    document.removeEventListener("focusin", observer, true)
    dialog.remove()
    trigger.remove()
  })
  test("does not steal focus from a newly opened dialog", () => {
    const root = document.createElement("div")
    const dialog = document.createElement("div")
    dialog.dataset.slot = "dialog-content"
    dialog.setAttribute("data-expanded", "")
    root.append(dialog)
    const event = new Event("closeAutoFocus", { cancelable: true })
    keepDialogFocus(event, root)
    expect(event.defaultPrevented).toBe(true)
  })
  test("still restores the menu trigger when there is no open dialog", () => {
    const root = document.createElement("div")
    const closed = document.createElement("div")
    closed.dataset.slot = "dialog-content"
    closed.setAttribute("data-closed", "")
    root.append(closed)
    const event = new Event("closeAutoFocus", { cancelable: true })
    keepDialogFocus(event, root)
    expect(event.defaultPrevented).toBe(false)
  })
})
