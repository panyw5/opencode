import { afterEach, describe, expect, test } from "bun:test"
import { findInPage } from "./find-in-page"

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
  else Reflect.deleteProperty(globalThis, "document")
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

describe("findInPage", () => {
  test("does not search the find input's own value", () => {
    const input = { value: "needle" }
    let valueDuringFind: string | undefined

    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelectorAll: () => [input],
      },
    })
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        find: () => {
          valueDuringFind = input.value
          return false
        },
      },
    })

    expect(findInPage("needle", 1)).toBe(false)
    expect(valueDuringFind).toBe("")
    expect(input.value).toBe("needle")
  })
})
