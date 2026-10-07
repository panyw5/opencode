import { afterEach, describe, expect, test } from "bun:test"
import {
  composerBoundary,
  composerOwnsTarget,
  isMainComposerCommand,
  mayFocusComposer,
  resolveDropComposer,
} from "./composer-boundary"

const roots: HTMLElement[] = []
function composer(kind: string) {
  const root = document.createElement("div")
  root.dataset.promptComposer = kind
  root.dataset.promptKind = kind
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  editor.tabIndex = 0
  const button = document.createElement("button")
  root.append(editor, button)
  document.body.append(root)
  roots.push(root)
  return { root, editor, button }
}
afterEach(() => roots.splice(0).forEach((root) => root.remove()))

describe("composer event isolation", () => {
  test("toolbars and editor events retain their own composer boundary", () => {
    const main = composer("main")
    const quick = composer("quick")
    expect(composerBoundary(quick.button)).toBe(quick.root)
    expect(composerOwnsTarget(main.editor, quick.editor)).toBe(false)
    expect(composerOwnsTarget(main.editor, quick.button)).toBe(false)
    expect(composerOwnsTarget(quick.editor, quick.button)).toBe(true)
    expect(composerOwnsTarget(quick.editor, main.editor)).toBe(false)
    expect(composerOwnsTarget(main.editor, document.body)).toBe(false)
  })

  test("deferred focus cannot jump between the two inputs", () => {
    const main = composer("main")
    const quick = composer("quick")
    quick.editor.focus()
    expect(mayFocusComposer(main.editor)).toBe(false)
    expect(mayFocusComposer(quick.editor)).toBe(true)
    main.editor.focus()
    expect(mayFocusComposer(quick.editor)).toBe(false)
    expect(mayFocusComposer(main.editor)).toBe(true)
    main.root.remove()
    expect(mayFocusComposer(main.editor)).toBe(false)
  })

  test("main input/session shortcuts are distinguishable from global navigation", () => {
    for (const id of [
      "file.attach",
      "file.attachMarkdown",
      "input.focus",
      "prompt.mode.shell",
      "model.choose",
      "agent.cycle",
      "session.new",
      "session.undo",
      "mcp.toggle",
      "skill.list",
    ])
      expect(isMainComposerCommand(id)).toBe(true)
    for (const id of ["command.palette", "sidebar.toggle", "project.switch", "settings.open", "assistant.quick.toggle"])
      expect(isMainComposerCommand(id)).toBe(false)
  })

  test("drop ownership follows coordinates and never falls back to focused input", () => {
    const main = composer("main")
    const quick = composer("quick")
    quick.editor.focus()
    const original = document.elementsFromPoint
    try {
      document.elementsFromPoint = () => [main.editor, main.root]
      expect(resolveDropComposer({ x: 1, y: 1 })).toBe(main.root)
      document.elementsFromPoint = () => [document.body]
      expect(resolveDropComposer({ x: 2, y: 2 })).toBeUndefined()
      expect(resolveDropComposer()).toBeUndefined()
    } finally {
      document.elementsFromPoint = original
    }
  })
})
