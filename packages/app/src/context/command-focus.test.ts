import { afterEach, describe, expect, test } from "bun:test"
import { focusCommandScope, keybindScopeMatches } from "./command-focus"

const roots: HTMLElement[] = []
function panel(scope: string) {
  const root = document.createElement("div")
  root.dataset.commandScope = scope
  root.tabIndex = -1
  const text = document.createElement("p")
  text.textContent = "Message text"
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  editor.tabIndex = 0
  root.append(text, editor)
  document.body.append(root)
  roots.push(root)
  return { root, text, editor }
}
afterEach(() => roots.splice(0).forEach((root) => root.remove()))

describe("command keybind focus scope", () => {
  test("allows message navigation in the focused session text and main composer", () => {
    const main = panel("session")
    main.root.focus()
    expect(keybindScopeMatches("session", main.root)).toBe(true)
    main.editor.focus()
    expect(keybindScopeMatches("session", main.editor)).toBe(true)
  })

  test("rejects quick assistant, sidebar, terminal, and body focus", () => {
    for (const scope of ["quick-assistant", "sidebar", "terminal"]) {
      const other = panel(scope)
      other.editor.focus()
      expect(keybindScopeMatches("session", other.editor)).toBe(false)
    }
    expect(keybindScopeMatches("session", document.body, document.body)).toBe(false)
  })

  test("does not trust a session target while another panel actually owns focus", () => {
    const main = panel("session")
    const other = panel("quick-assistant")
    other.editor.focus()
    expect(keybindScopeMatches("session", main.editor)).toBe(false)
  })

  test("does not inherit the outer session scope through a nested foreign panel", () => {
    const main = panel("session")
    const quick = panel("quick-assistant")
    main.root.append(quick.root)
    quick.editor.focus()
    expect(keybindScopeMatches("session", quick.editor)).toBe(false)
  })

  test("does not share focus between two cached session panels", () => {
    const first = panel("session")
    const second = panel("session")
    first.root.focus()
    expect(keybindScopeMatches("session", second.root)).toBe(false)
  })

  test("rejects hidden, inert, and disconnected scope roots", () => {
    const main = panel("session")
    for (const attribute of ["hidden", "inert", "aria-hidden"]) {
      main.root.setAttribute(attribute, "true")
      expect(keybindScopeMatches("session", main.root, main.root)).toBe(false)
      main.root.removeAttribute(attribute)
    }
    main.root.remove()
    expect(keybindScopeMatches("session", main.root, main.root)).toBe(false)
  })

  test("keeps unscoped commands global", () => {
    expect(keybindScopeMatches(undefined, document.body)).toBe(true)
  })

  test("clicking message text focuses its panel without stealing editor or control focus", () => {
    const main = panel("session")
    const quick = panel("quick-assistant")
    main.editor.focus()
    expect(focusCommandScope(quick.root, quick.text)).toBe(true)
    expect(document.activeElement).toBe(quick.root)
    expect(focusCommandScope(quick.root, quick.editor)).toBe(false)
    quick.editor.focus()
    const button = document.createElement("button")
    quick.root.append(button)
    expect(focusCommandScope(quick.root, button)).toBe(false)
    expect(document.activeElement).toBe(quick.editor)
    expect(focusCommandScope(main.root, quick.text)).toBe(false)
  })
})
