import { describe, expect, test } from "bun:test"
import { createComponent, createSignal } from "solid-js"
import { render } from "solid-js/web"
import "./solid-form-loader"
const { SectionButton } = await import("../../src/pages/config-section-button")

describe("config section button contracts", () => {
  test("loading entries are disabled and become interactive when ready", () => {
    const container = document.createElement("div")
    document.body.append(container)
    const [loading, setLoading] = createSignal(true)
    const [current, setCurrent] = createSignal(false)
    let clicks = 0
    const dispose = render(
      () =>
        createComponent(SectionButton, {
          title: "Extensions",
          icon: "dot-grid",
          get current() {
            return current()
          },
          get disabled() {
            return loading()
          },
          onClick: () => {
            clicks++
            setCurrent(true)
          },
        }),
      container,
    )
    try {
      const button = container.querySelector("button")!
      expect(button.disabled).toBe(true)
      button.click()
      expect(clicks).toBe(0)
      expect(button.getAttribute("aria-current")).toBeNull()
      setLoading(false)
      expect(button.disabled).toBe(false)
      button.click()
      expect(clicks).toBe(1)
      expect(button.getAttribute("aria-current")).toBe("page")
    } finally {
      dispose()
      container.remove()
    }
  })
})
