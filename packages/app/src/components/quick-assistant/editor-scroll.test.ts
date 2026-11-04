import { afterEach, describe, expect, test } from "bun:test"
import { scrollQuickEditorCaretIntoView } from "./editor-scroll"

function setup(top: number, bottom: number, scrollTop = 0) {
  const editor = document.createElement("div")
  editor.tabIndex = 0
  editor.textContent = "​"
  document.body.append(editor)
  editor.focus()
  Object.defineProperties(editor, {
    clientTop: { value: 0 },
    clientHeight: { value: 256 },
    scrollHeight: { value: 800 },
  })
  editor.scrollTop = scrollTop
  editor.getBoundingClientRect = () => new DOMRect(0, 100, 300, 256)
  const range = document.createRange()
  range.setStart(editor.firstChild!, 1)
  range.collapse(true)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  selection.getRangeAt(0).getBoundingClientRect = () => new DOMRect(0, top, 0, bottom - top)
  return { editor, selection }
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe("quick assistant editor caret scrolling", () => {
  test("reveals the empty new line below the visible editor", () => {
    const { editor } = setup(370, 396)
    scrollQuickEditorCaretIntoView(editor)
    expect(editor.scrollTop).toBe(44)
  })

  test("reveals a caret above the viewport without scrolling to the end", () => {
    const { editor } = setup(70, 96, 150)
    scrollQuickEditorCaretIntoView(editor)
    expect(editor.scrollTop).toBe(116)
  })

  test("keeps the viewport unchanged while editing a visible middle line", () => {
    const { editor } = setup(200, 226, 100)
    scrollQuickEditorCaretIntoView(editor)
    expect(editor.scrollTop).toBe(100)
  })

  test("does not scroll after focus moves to another control", () => {
    const { editor } = setup(370, 396)
    editor.blur()
    scrollQuickEditorCaretIntoView(editor)
    expect(editor.scrollTop).toBe(0)
  })

  test("ignores a selection belonging to another editor", () => {
    const { editor, selection } = setup(370, 396)
    const other = document.createElement("div")
    other.textContent = "other"
    document.body.append(other)
    selection.collapse(other.firstChild, 1)
    scrollQuickEditorCaretIntoView(editor)
    expect(editor.scrollTop).toBe(0)
  })

  test("does not scroll a non-collapsed selection", () => {
    const { editor, selection } = setup(370, 396)
    selection.setBaseAndExtent(editor.firstChild!, 0, editor.firstChild!, 1)
    scrollQuickEditorCaretIntoView(editor)
    expect(editor.scrollTop).toBe(0)
  })

  test("ignores an empty range without layout geometry", () => {
    const { editor } = setup(0, 0, 100)
    scrollQuickEditorCaretIntoView(editor)
    expect(editor.scrollTop).toBe(100)
  })
})
