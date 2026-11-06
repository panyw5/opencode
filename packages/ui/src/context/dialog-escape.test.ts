import { expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { nestedDialogEscape } from "./dialog-escape"

if (!globalThis.document) GlobalRegistrator.register()

test("Escape belongs to the resolution menu, not its containing share dialog", () => {
  const dialog = document.createElement("div")
  dialog.setAttribute("role", "dialog")
  dialog.setAttribute("data-slot", "dialog-content")
  dialog.innerHTML = '<button>Export</button><div role="menu"><div role="menuitem">1170px</div></div>'
  expect(nestedDialogEscape(dialog.querySelector('[role="menuitem"]'))).toBe(true)
  expect(nestedDialogEscape(dialog.querySelector("button"))).toBe(false)
  expect(nestedDialogEscape(null)).toBe(false)
})
