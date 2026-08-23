import { describe, expect, test } from "bun:test"
import { scrollEventGeometry, scrollKey, scrollThumbGeometry } from "./scroll-view"

describe("scrollKey", () => {
  test("maps plain navigation keys", () => {
    expect(scrollKey({ key: "PageDown", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(
      "page-down",
    )
    expect(scrollKey({ key: "ArrowUp", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe("up")
  })

  test("ignores modified keybinds", () => {
    expect(
      scrollKey({ key: "ArrowDown", altKey: false, ctrlKey: false, metaKey: true, shiftKey: false }),
    ).toBeUndefined()
    expect(scrollKey({ key: "PageUp", altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBeUndefined()
    expect(scrollKey({ key: "End", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true })).toBeUndefined()
  })
})

describe("scrollThumbGeometry", () => {
  test("uses supplied virtual geometry for thumb size and position", () => {
    expect(scrollThumbGeometry({ scrollTop: 450, scrollHeight: 1800, clientHeight: 900 })).toEqual({
      height: 442,
      top: 229,
    })
  })

  test("hides the thumb when content does not overflow", () => {
    expect(scrollThumbGeometry({ scrollTop: 0, scrollHeight: 800, clientHeight: 900 })).toBeUndefined()
  })
})

describe("scrollEventGeometry", () => {
  test("keeps the live scroll offset while reusing cached dimensions", () => {
    expect(
      scrollEventGeometry({
        scrollTop: 11069,
        scrollHeight: 58099,
        clientHeight: 834,
        cachedScrollHeight: 58099,
        cachedClientHeight: 834,
      }),
    ).toEqual({ scrollTop: 11069, scrollHeight: 58099, clientHeight: 834 })
  })
})
