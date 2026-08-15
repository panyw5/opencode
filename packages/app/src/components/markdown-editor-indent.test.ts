import { describe, expect, test } from "bun:test"
import { handleTextareaIndent, indent } from "./markdown-editor-indent"

describe("markdown editor indent", () => {
  test("inserts two spaces at caret", () => {
    expect(
      indent({
        text: "hello",
        start: 0,
        end: 0,
        shiftKey: false,
      }),
    ).toEqual({
      text: "  hello",
      start: 2,
      end: 2,
    })
  })

  test("inserts two spaces in the middle of a line", () => {
    expect(
      indent({
        text: "ab",
        start: 1,
        end: 1,
        shiftKey: false,
      }),
    ).toEqual({
      text: "a  b",
      start: 3,
      end: 3,
    })
  })

  test("outdents two spaces with shift+tab at caret", () => {
    expect(
      indent({
        text: "  hello",
        start: 2,
        end: 2,
        shiftKey: true,
      }),
    ).toEqual({
      text: "hello",
      start: 0,
      end: 0,
    })
  })

  test("outdents a single leading space when only one remains", () => {
    expect(
      indent({
        text: " hello",
        start: 1,
        end: 1,
        shiftKey: true,
      }),
    ).toEqual({
      text: "hello",
      start: 0,
      end: 0,
    })
  })

  test("returns null when shift+tab has nothing to remove", () => {
    expect(
      indent({
        text: "hello",
        start: 2,
        end: 2,
        shiftKey: true,
      }),
    ).toBeNull()
  })

  test("indents every selected line", () => {
    expect(
      indent({
        text: "one\ntwo\nthree",
        start: 0,
        end: 7,
        shiftKey: false,
      }),
    ).toEqual({
      text: "  one\n  two\nthree",
      start: 2,
      end: 11,
    })
  })

  test("outdents every selected line", () => {
    expect(
      indent({
        text: "  one\n  two\nthree",
        start: 0,
        end: 11,
        shiftKey: true,
      }),
    ).toEqual({
      text: "one\ntwo\nthree",
      start: 0,
      end: 7,
    })
  })

  test("outdents a hard tab", () => {
    expect(
      indent({
        text: "\thello",
        start: 1,
        end: 1,
        shiftKey: true,
      }),
    ).toEqual({
      text: "hello",
      start: 0,
      end: 0,
    })
  })

  test("handleTextareaIndent ignores non-tab keys", () => {
    const event = {
      key: "a",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 65,
      preventDefault() {},
      currentTarget: { selectionStart: 0, selectionEnd: 0, setSelectionRange() {} },
    } as unknown as KeyboardEvent & { currentTarget: HTMLTextAreaElement }
    expect(handleTextareaIndent(event, "hello", () => {})).toBe(false)
  })

  test("handleTextareaIndent applies indent and prevents default", () => {
    let prevented = false
    let nextText = ""
    const event = {
      key: "Tab",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      keyCode: 9,
      preventDefault() {
        prevented = true
      },
      currentTarget: { selectionStart: 0, selectionEnd: 0, setSelectionRange() {} },
    } as unknown as KeyboardEvent & { currentTarget: HTMLTextAreaElement }
    expect(
      handleTextareaIndent(event, "hello", (next) => {
        nextText = next.text
      }),
    ).toBe(true)
    expect(prevented).toBe(true)
    expect(nextText).toBe("  hello")
  })
})
