import { describe, expect, test } from "bun:test"

const css = await Bun.file(new URL("./popup-surfaces.css", import.meta.url)).text()

describe("desktop popup surfaces", () => {
  test("prompt menus and command dialogs share the same opaque surface rule", () => {
    const rule = css.match(/:is\(([\s\S]*?)\)\s*\{([\s\S]*?)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('[data-component="dialog"] [data-slot="dialog-content"]')
    expect(rule![1]).toContain('[data-component="prompt-popover"]')
    expect(rule![2]).toContain("background: var(--surface-raised-stronger-non-alpha)")
    expect(rule![2]).toContain("backdrop-filter: none")
    expect(rule![2]).toContain("-webkit-backdrop-filter: none")
  })
})
